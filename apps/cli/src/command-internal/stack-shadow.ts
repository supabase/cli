import { scryptSync } from "node:crypto";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- pid scopes the exclusive temp name across processes.
import process from "node:process";
import {
  Clock,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Redacted,
  Result,
  Scope,
  Semaphore,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  createEphemeralPostgres,
  databaseBootstrapIdentity,
  resolveEphemeralPostgresRelease,
  schemaInitArtifactIdentity,
  type CreateEphemeralPostgresOptions,
  type EffectEphemeralPostgres,
  type EphemeralPostgresRelease,
  type EphemeralPostgresSettings,
  type SchemaInitCapabilityName,
  type StackConfig,
  type StackRuntime,
  type StackRuntimePreference,
  type StackVersionUnsupportedError,
} from "@supabase/stack/effect";
import { Output } from "../shared/output/output.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { DbConnection } from "./db-connection.service.ts";
import { shadowBaselineCacheDir } from "./pgdelta.paths.ts";
import {
  SHADOW_BASELINE_KEEP,
  SHADOW_BASELINE_MAX_AGE_MS,
  SHADOW_CACHE_ENV,
  canonicalJson,
  shadowBaselineTarsToEvict,
  touchShadowBaselineTar,
} from "./db-bootstrap/shadow-cache.ts";
import { viperEnvBoolWithProjectFallback } from "./viper-env.ts";
import {
  connectShadowDatabase,
  ShadowDbError,
  type ShadowSetupInput,
  type ShadowSourceResult,
} from "./db-bootstrap/shadow-database.ts";
import { listLocalMigrationPaths } from "./migration-history.ts";
import { applyMigrations } from "./migration-apply.ts";
import { stackProjectRuntime } from "./stack-local-database.ts";
import { loadStackConfig } from "../commands/experimental/stack/stack-config.ts";
import { StackCatalogSetup } from "./stack-catalog-setup.ts";
import { resolveSetupWebhooksEnabled, type SetupDatabaseOptions } from "./db-bootstrap/db-setup.ts";
import type { VaultSecret } from "./vault.ts";

/** Optional factory so CLI tests can `Layer.succeed` a fake cluster. */
export class StackEphemeralPostgres extends Context.Service<
  StackEphemeralPostgres,
  {
    readonly create: typeof createEphemeralPostgres;
    readonly resolveRelease: typeof resolveEphemeralPostgresRelease;
  }
>()("supabase/experimental-stack/EphemeralPostgres") {}

export const ephemeralPostgresLayer = Layer.succeed(StackEphemeralPostgres, {
  create: createEphemeralPostgres,
  resolveRelease: resolveEphemeralPostgresRelease,
});

const TAR_PREFIX = "stack-shadow-baseline-";

/** A partial older than 5 minutes is abandoned; a live export finishes in seconds. */
const STACK_SHADOW_PARTIAL_ABANDON_MS = 5 * 60 * 1000;

export const stackShadowBaselineTarFileName = (key: string): string => `${TAR_PREFIX}${key}.tar`;

const isStackShadowBaselineTar = (fileName: string): boolean =>
  /^stack-shadow-baseline-[0-9a-f]{16}\.tar$/u.test(fileName);

export function isStackShadowBaselinePartial(fileName: string): boolean {
  return /^stack-shadow-baseline-[0-9a-f]{16}\.tar\.\d+\.partial$/u.test(fileName);
}

const stackShadowExportMutex = Semaphore.makeUnsafe(1);

export interface StackShadowCacheKeyInputs {
  readonly artifactIdentity: string;
  readonly majorVersion: number;
  readonly runtimeKind: string;
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  readonly dbPassword: string;
  readonly dbSettings: unknown;
  readonly rolesSql: string;
  readonly bootstrapIdentity: string;
  readonly webhooksEnabled: boolean;
  readonly apiGrantsKept: boolean;
  readonly vault: ReadonlyArray<VaultSecret>;
  readonly jwks: string;
  readonly storageTargetMigration: string;
  readonly authEnabled: boolean;
  readonly storageEnabled: boolean;
  readonly realtimeEnabled: boolean;
  readonly authArtifact: string;
  readonly storageArtifact: string;
  readonly realtimeArtifact: string;
}

export const stackShadowCacheKey = (inputs: StackShadowCacheKeyInputs): string => {
  const quoted = (value: string) => JSON.stringify(value);
  const lines: Array<string> = [
    `artifact=${quoted(inputs.artifactIdentity)}`,
    `major_version=${inputs.majorVersion}`,
    `runtime=${quoted(inputs.runtimeKind)}`,
    `jwt_secret=${quoted(inputs.jwtSecret)}`,
    `jwt_expiry=${inputs.jwtExpiry}`,
    `db_password=${quoted(inputs.dbPassword)}`,
    `db_settings=${canonicalJson(inputs.dbSettings ?? {})}`,
    `bootstrap=${quoted(inputs.bootstrapIdentity)}`,
    `api_grants_kept=${inputs.apiGrantsKept}`,
    `webhooks_enabled=${inputs.webhooksEnabled}`,
    `schema_init=auth=${inputs.authEnabled},storage=${inputs.storageEnabled},realtime=${inputs.realtimeEnabled}`,
    inputs.authEnabled ? `auth_artifact=${quoted(inputs.authArtifact)}` : "auth_artifact=excluded",
    inputs.storageEnabled
      ? `storage_artifact=${quoted(inputs.storageArtifact)}`
      : "storage_artifact=excluded",
    inputs.realtimeEnabled
      ? `realtime_artifact=${quoted(inputs.realtimeArtifact)}`
      : "realtime_artifact=excluded",
    inputs.realtimeEnabled && inputs.majorVersion >= 15
      ? `realtime_jwks=${quoted(inputs.jwks)}`
      : "realtime_jwks=excluded",
    inputs.storageEnabled && inputs.majorVersion >= 15
      ? `storage_target_migration=${quoted(inputs.storageTargetMigration)}`
      : "storage_target_migration=excluded",
  ];
  for (const secret of inputs.vault
    .filter((secret) => secret.resolved)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    lines.push(`vault=${JSON.stringify([secret.name, secret.value])}`);
  }
  return scryptSync(
    `${lines.join("\n")}\nroles_sql=\n${inputs.rolesSql}`,
    "supabase-stack-shadow-cache-key",
    32,
  )
    .toString("hex")
    .slice(0, 16);
};

const capabilityPinVersion = (
  cap: { readonly enabled?: boolean; readonly version?: string } | undefined,
): string | undefined => (cap === undefined || cap.enabled === false ? undefined : cap.version);

const trioSchemaInitArtifact = (
  enabled: boolean,
  name: Extract<SchemaInitCapabilityName, "auth" | "storage" | "realtime">,
  config: StackConfig | undefined,
): string => {
  if (!enabled) return "";
  return (
    schemaInitArtifactIdentity(name, capabilityPinVersion(config?.capabilities?.[name])) ??
    "missing"
  );
};

export interface StackShadowAcquiredHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly artifactIdentity: string;
  readonly runtime: StackRuntime;
  readonly baselinePresent: boolean;
  readonly snapshotKey?: string;
  readonly ephemeral: EffectEphemeralPostgres;
}

export interface StackShadowAcquireOpts {
  readonly bypassCache?: boolean;
  readonly port?: number;
  readonly runtime?: StackRuntimePreference;
  readonly webhooks?: SetupDatabaseOptions["webhooks"];
}

const cacheEnabled = (projectEnv: Record<string, string> | undefined, bypass: boolean): boolean =>
  !bypass &&
  viperEnvBoolWithProjectFallback(SHADOW_CACHE_ENV, projectEnv ?? {}, {
    whenUnset: true,
  });

const readRolesSql = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
): Effect.Effect<string, ShadowDbError> =>
  fs.readFileString(path.join(workdir, "supabase", "roles.sql")).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Predicate.isTagged(error.reason, "NotFound")
        ? Effect.succeed("")
        : Effect.fail(
            new ShadowDbError({
              message: `failed to read supabase/roles.sql: ${error.message}`,
              reason: "filesystem",
            }),
          ),
    ),
  );

const runtimePreference = (
  runtime: StackRuntime | undefined,
  override?: StackRuntimePreference,
): StackRuntimePreference | undefined => {
  if (override !== undefined) return override;
  if (runtime === undefined) return undefined;
  return runtime.kind === "native"
    ? { kind: "native" }
    : { kind: "container", engine: runtime.engine };
};

const postgresSettings = (value: unknown): EphemeralPostgresSettings | undefined => {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
};

const createOptions = (
  input: ShadowSetupInput<unknown>,
  runtime: StackRuntimePreference | undefined,
  restoreFrom: string | undefined,
  port: number | undefined,
): CreateEphemeralPostgresOptions => ({
  databasePassword: Redacted.make(input.password),
  jwtSecret: Redacted.make(input.jwtSecret),
  jwtExpiry: input.jwtExpiry,
  postgresSettings: postgresSettings(input.db.settings),
  healthTimeout: `${String(input.healthTimeoutSeconds)}s`,
  version: String(input.setup.majorVersion),
  ...(runtime === undefined ? {} : { runtime }),
  ...(port === undefined ? {} : { port }),
  ...(restoreFrom === undefined ? {} : { restoreFrom }),
});

const connFrom = (handle: EffectEphemeralPostgres, password: string) => ({
  host: handle.host,
  port: handle.port,
  user: "postgres",
  password,
  database: "postgres",
});

const applyColdCatalog = (
  handle: EffectEphemeralPostgres,
  input: ShadowSetupInput<unknown>,
  webhooks: SetupDatabaseOptions["webhooks"],
): Effect.Effect<void, ShadowDbError, FileSystem.FileSystem | Path.Path | Output> =>
  Effect.gen(function* () {
    const catalog = yield* Effect.serviceOption(StackCatalogSetup);
    if (Option.isNone(catalog))
      return yield* new ShadowDbError({
        message: "stack catalog setup is unavailable",
        reason: "database",
      });
    const config = yield* loadStackConfig(input.workdir).pipe(
      Effect.mapError(
        (cause) => new ShadowDbError({ message: cause.message, reason: "filesystem" }),
      ),
    );
    yield* catalog.value
      .apply({
        target: {
          kind: "ephemeral",
          projectRoot: input.workdir,
          runtime: handle.runtime,
          config,
          databaseUrl: Redacted.value(handle.url),
          databasePassword: Redacted.make(input.password),
          jwtSecret: Redacted.make(input.jwtSecret),
        },
        overlay: {
          webhooks,
          webhooksEnabled: input.setup.webhooksEnabled,
          apiAutoExposeNewTables: input.setup.apiAutoExposeNewTables,
          vault: input.setup.vault,
          workdir: input.workdir,
          announceRoles: false,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) => new ShadowDbError({ message: cause.message, reason: "database" }),
        ),
      );
  });

const artifactIdentityFor = (
  runtime: StackRuntimePreference | undefined,
  version: string,
  image: string,
): string =>
  runtime?.kind === "container"
    ? `container:${runtime.engine ?? "docker"}:${image}`
    : `native:${version}`;

const sweepAbandonedPartials = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cacheDir: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const names = yield* fs.readDirectory(cacheDir).pipe(Effect.orElseSucceed(() => []));
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      names.filter(isStackShadowBaselinePartial),
      (fileName) =>
        Effect.gen(function* () {
          const filePath = path.join(cacheDir, fileName);
          const info = yield* fs.stat(filePath);
          const mtime = Option.getOrUndefined(info.mtime);
          if (mtime !== undefined && now - mtime.getTime() > STACK_SHADOW_PARTIAL_ABANDON_MS) {
            yield* fs.remove(filePath).pipe(Effect.ignore);
          }
        }).pipe(Effect.ignore),
      { discard: true },
    );
  });

const sweepCache = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cacheDir: string,
  keepName: string | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const names = yield* fs.readDirectory(cacheDir).pipe(Effect.orElseSucceed(() => []));
    const entries: Array<{ readonly fileName: string; readonly mtimeMs: number }> = [];
    for (const fileName of names) {
      if (!isStackShadowBaselineTar(fileName)) continue;
      const info = yield* fs.stat(path.join(cacheDir, fileName)).pipe(Effect.option);
      if (Option.isNone(info) || Option.isNone(info.value.mtime)) continue;
      entries.push({ fileName, mtimeMs: info.value.mtime.value.getTime() });
    }
    yield* Effect.forEach(
      shadowBaselineTarsToEvict(entries, now, {
        keep: SHADOW_BASELINE_KEEP,
        maxAgeMs: SHADOW_BASELINE_MAX_AGE_MS,
        retainFileName: keepName,
        isPublishedTar: isStackShadowBaselineTar,
      }),
      (fileName) => fs.remove(path.join(cacheDir, fileName)).pipe(Effect.ignore),
      { discard: true },
    );
  });

const writeStackShadowBaselineTar = <R>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cacheDir: string,
  tarPath: string,
  exportPgData: (tempPath: string) => Effect.Effect<void, ShadowDbError, R>,
  skipIfPublished: boolean,
): Effect.Effect<void, ShadowDbError, R> =>
  stackShadowExportMutex.withPermit(
    Effect.gen(function* () {
      if (skipIfPublished) {
        const published = yield* fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
        if (published) return;
      }
      yield* fs.makeDirectory(cacheDir, { recursive: true, mode: 0o700 }).pipe(
        Effect.mapError(
          (cause) =>
            new ShadowDbError({
              message: `failed to create ${cacheDir}: ${cause.message}`,
              reason: "filesystem",
            }),
        ),
      );
      yield* sweepAbandonedPartials(fs, path, cacheDir);
      const tempPath = `${tarPath}.${String(process.pid)}.partial`;
      yield* fs.remove(tempPath).pipe(Effect.ignore);
      yield* Effect.gen(function* () {
        yield* Effect.scoped(
          fs.open(tempPath, { flag: "wx", mode: 0o600 }).pipe(
            Effect.mapError(
              (cause) =>
                new ShadowDbError({
                  message: `failed to create ${tempPath}: ${cause.message}`,
                  reason: "filesystem",
                }),
            ),
            Effect.asVoid,
          ),
        );
        yield* exportPgData(tempPath);
        yield* fs.chmod(tempPath, 0o600).pipe(
          Effect.mapError(
            (cause) =>
              new ShadowDbError({
                message: `failed to restrict ${tempPath}: ${cause.message}`,
                reason: "filesystem",
              }),
          ),
        );
        yield* fs.rename(tempPath, tarPath).pipe(
          Effect.mapError(
            (cause) =>
              new ShadowDbError({
                message: `failed to publish ${tarPath}: ${cause.message}`,
                reason: "filesystem",
              }),
          ),
        );
      }).pipe(Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignore)));
      yield* sweepCache(fs, path, cacheDir, path.basename(tarPath));
    }),
  );

const mapCreateError = (cause: unknown): ShadowDbError =>
  new ShadowDbError({
    message:
      typeof cause === "object" && cause !== null && "message" in cause
        ? String(Reflect.get(cause, "message"))
        : String(cause),
    reason: "database",
  });

const runtimeKindFor = (runtime: StackRuntimePreference | undefined): string =>
  runtime?.kind === "container" ? `container:${runtime.engine ?? "docker"}` : "native";

const ephemeralApis = (): Effect.Effect<{
  readonly create: typeof createEphemeralPostgres;
  readonly resolveRelease: (
    version?: string,
  ) => Effect.Effect<EphemeralPostgresRelease, StackVersionUnsupportedError>;
}> =>
  Effect.serviceOption(StackEphemeralPostgres).pipe(
    Effect.map((value) =>
      Option.getOrElse(value, () => ({
        create: createEphemeralPostgres,
        resolveRelease: resolveEphemeralPostgresRelease,
      })),
    ),
  );

const ownCluster = (ephemeral: EffectEphemeralPostgres) =>
  Effect.addFinalizer(() => ephemeral.stop.pipe(Effect.ignore));

export const stackAcquireShadowDatabase = <E>(
  input: ShadowSetupInput<E>,
  opts: StackShadowAcquireOpts = {},
): Effect.Effect<
  StackShadowAcquiredHandle,
  ShadowDbError | E,
  | Output
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
  | CommandSettings
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const apis = yield* ephemeralApis();
    const projectRuntime = yield* stackProjectRuntime;
    const runtime = runtimePreference(projectRuntime, opts.runtime);
    const rolesSql = yield* readRolesSql(input.fs, input.path, input.workdir);
    const cacheOn = cacheEnabled(input.setup.projectEnvValues, opts.bypassCache === true);
    const cacheDir = shadowBaselineCacheDir(path);
    const webhooks = opts.webhooks;
    yield* fs.makeDirectory(cacheDir, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);

    const startEmpty = () =>
      apis
        .create(createOptions(input, runtime, undefined, opts.port))
        .pipe(Effect.mapError(mapCreateError));

    if (!cacheOn) {
      const ephemeral = yield* startEmpty();
      yield* ownCluster(ephemeral);
      yield* applyColdCatalog(ephemeral, input, webhooks);
      return {
        url: Redacted.value(ephemeral.url),
        host: ephemeral.host,
        port: ephemeral.port,
        artifactIdentity: ephemeral.artifactIdentity,
        runtime: ephemeral.runtime,
        baselinePresent: false,
        ephemeral,
      };
    }

    const jwks =
      input.setup.realtimeEnabledForSetup && input.setup.majorVersion >= 15
        ? yield* input.setup.jwks
        : "";
    const release = yield* apis
      .resolveRelease(String(input.setup.majorVersion))
      .pipe(Effect.mapError(mapCreateError));
    const identity = artifactIdentityFor(runtime, release.version, release.image);
    const trioEnabled =
      input.setup.authEnabledForSetup ||
      input.setup.storageEnabledForSetup ||
      input.setup.realtimeEnabledForSetup;
    const stackConfig = trioEnabled
      ? yield* loadStackConfig(input.workdir).pipe(
          Effect.mapError(
            (cause) => new ShadowDbError({ message: cause.message, reason: "filesystem" }),
          ),
        )
      : undefined;
    const key = stackShadowCacheKey({
      artifactIdentity: identity,
      majorVersion: input.setup.majorVersion,
      runtimeKind: runtimeKindFor(runtime),
      jwtSecret: input.jwtSecret,
      jwtExpiry: input.jwtExpiry,
      dbPassword: input.password,
      dbSettings: input.db.settings,
      rolesSql,
      bootstrapIdentity: databaseBootstrapIdentity,
      webhooksEnabled: resolveSetupWebhooksEnabled(webhooks, input.setup.webhooksEnabled),
      apiGrantsKept: Option.getOrElse(input.setup.apiAutoExposeNewTables, () => true),
      vault: input.setup.vault,
      jwks,
      storageTargetMigration: input.setup.storageTargetMigration,
      authEnabled: input.setup.authEnabledForSetup,
      storageEnabled: input.setup.storageEnabledForSetup,
      realtimeEnabled: input.setup.realtimeEnabledForSetup,
      authArtifact: trioSchemaInitArtifact(input.setup.authEnabledForSetup, "auth", stackConfig),
      storageArtifact: trioSchemaInitArtifact(
        input.setup.storageEnabledForSetup,
        "storage",
        stackConfig,
      ),
      realtimeArtifact: trioSchemaInitArtifact(
        input.setup.realtimeEnabledForSetup,
        "realtime",
        stackConfig,
      ),
    });
    const tarName = stackShadowBaselineTarFileName(key);
    const tarPath = path.join(cacheDir, tarName);
    const cached = yield* fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
    yield* sweepAbandonedPartials(fs, path, cacheDir);
    yield* sweepCache(fs, path, cacheDir, tarName);

    if (cached) {
      const restored = yield* Effect.result(
        apis.create(createOptions(input, runtime, tarPath, opts.port)),
      );
      if (Result.isSuccess(restored)) {
        yield* ownCluster(restored.success);
        yield* touchShadowBaselineTar(fs, tarPath);
        return {
          url: Redacted.value(restored.success.url),
          host: restored.success.host,
          port: restored.success.port,
          artifactIdentity: restored.success.artifactIdentity,
          runtime: restored.success.runtime,
          baselinePresent: true,
          snapshotKey: key,
          ephemeral: restored.success,
        };
      }
      const output = yield* Output;
      yield* output.raw(
        `Warning: shadow baseline not cached: ${restored.failure.message}\n`,
        "stderr",
      );
    }

    const probe = yield* startEmpty();
    yield* ownCluster(probe);
    yield* applyColdCatalog(probe, input, webhooks);
    const exported = yield* Effect.result(
      Effect.gen(function* () {
        const rolesSqlNow = yield* readRolesSql(input.fs, input.path, input.workdir);
        if (rolesSqlNow !== rolesSql) {
          return yield* new ShadowDbError({
            message: "supabase/roles.sql changed during provisioning",
            reason: "filesystem",
          });
        }
        yield* probe.stop.pipe(Effect.mapError(mapCreateError));
        yield* writeStackShadowBaselineTar(
          fs,
          path,
          cacheDir,
          tarPath,
          (tempPath) => probe.exportPgData(tempPath).pipe(Effect.mapError(mapCreateError)),
          !cached,
        );
      }),
    );
    yield* probe.start.pipe(Effect.mapError(mapCreateError));
    if (Result.isFailure(exported)) {
      const output = yield* Output;
      yield* output.raw(
        `Warning: shadow baseline not cached: ${exported.failure.message}\n`,
        "stderr",
      );
    }
    return {
      url: Redacted.value(probe.url),
      host: probe.host,
      port: probe.port,
      artifactIdentity: probe.artifactIdentity,
      runtime: probe.runtime,
      baselinePresent: false,
      snapshotKey: Result.isSuccess(exported) ? key : undefined,
      ephemeral: probe,
    };
  });

export const stackWithShadowDatabase = <E, A, E2, R2>(
  input: ShadowSetupInput<E>,
  use: (handle: StackShadowAcquiredHandle) => Effect.Effect<A, E2, R2>,
  opts: StackShadowAcquireOpts = {},
): Effect.Effect<
  A,
  E2 | ShadowDbError | E,
  | R2
  | Output
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | CommandSettings
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* stackAcquireShadowDatabase(input, opts);
      return yield* use(handle);
    }),
  );

export const stackPrepareShadowSource = (
  handle: StackShadowAcquiredHandle,
  input: ShadowSetupInput<unknown>,
): Effect.Effect<
  Pick<ShadowSourceResult, "sourceUrl" | "targetUrlOverride">,
  ShadowDbError,
  DbConnection | Output | Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
  stackMigrateShadow(handle, input).pipe(
    Effect.as({ sourceUrl: handle.url, targetUrlOverride: undefined }),
  );

export const stackMigrateShadow = (
  handle: StackShadowAcquiredHandle,
  input: ShadowSetupInput<unknown>,
): Effect.Effect<
  void,
  ShadowDbError,
  DbConnection | Output | Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const migrationsDir = input.path.join(input.workdir, "supabase", "migrations");
      const pending = yield* listLocalMigrationPaths(input.fs, input.path, migrationsDir).pipe(
        Effect.mapError(
          (cause) => new ShadowDbError({ message: cause.message, reason: "filesystem" }),
        ),
      );
      const session = yield* connectShadowDatabase(connFrom(handle.ephemeral, input.password));
      yield* applyMigrations(
        session,
        input.fs,
        input.path,
        pending,
        (message) => new ShadowDbError({ message, reason: "database" }),
      ).pipe(
        Effect.catchTag("DbConnectError", (cause) =>
          Effect.fail(new ShadowDbError({ message: cause.message, reason: "connect" })),
        ),
      );
    }),
  );
