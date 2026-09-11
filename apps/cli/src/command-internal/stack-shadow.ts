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
  type CreateEphemeralPostgresOptions,
  type EffectEphemeralPostgres,
  type EphemeralPostgresRelease,
  type EphemeralPostgresSettings,
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
import { applyMigrations, seedGlobals } from "./migration-apply.ts";
import { stackProjectRuntime } from "./stack-local-database.ts";

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
}

export const stackShadowCacheKey = (inputs: StackShadowCacheKeyInputs): string => {
  const quoted = (value: string) => JSON.stringify(value);
  const payload = [
    `artifact=${quoted(inputs.artifactIdentity)}`,
    `major_version=${inputs.majorVersion}`,
    `runtime=${quoted(inputs.runtimeKind)}`,
    `jwt_secret=${quoted(inputs.jwtSecret)}`,
    `jwt_expiry=${inputs.jwtExpiry}`,
    `db_password=${quoted(inputs.dbPassword)}`,
    `db_settings=${canonicalJson(inputs.dbSettings ?? {})}`,
    `bootstrap=${quoted(inputs.bootstrapIdentity)}`,
  ].join("\n");
  return scryptSync(
    `${payload}\nroles_sql=\n${inputs.rolesSql}`,
    "supabase-stack-shadow-cache-key",
    32,
  )
    .toString("hex")
    .slice(0, 16);
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

const applyRoles = (
  handle: EffectEphemeralPostgres,
  input: ShadowSetupInput<unknown>,
  rolesSql: string,
): Effect.Effect<void, ShadowDbError, DbConnection | Output | Scope.Scope> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (rolesSql.length === 0) return;
      const session = yield* connectShadowDatabase(connFrom(handle, input.password));
      yield* seedGlobals(
        session,
        input.fs,
        input.path,
        [input.path.join(input.workdir, "supabase", "roles.sql")],
        (message) => new ShadowDbError({ message, reason: "database" }),
      ).pipe(
        Effect.catchTag("DbConnectError", (cause) =>
          Effect.fail(new ShadowDbError({ message: cause.message, reason: "connect" })),
        ),
      );
    }),
  );

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

export const stackAcquireShadowDatabase = <E>(
  input: ShadowSetupInput<E>,
  opts: StackShadowAcquireOpts = {},
): Effect.Effect<
  StackShadowAcquiredHandle,
  ShadowDbError | E,
  | Output
  | DbConnection
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
    yield* fs.makeDirectory(cacheDir, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);

    const startEmpty = () =>
      apis
        .create(createOptions(input, runtime, undefined, opts.port))
        .pipe(Effect.mapError(mapCreateError));

    if (!cacheOn) {
      const ephemeral = yield* startEmpty();
      yield* applyRoles(ephemeral, input, rolesSql);
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

    const release = yield* apis
      .resolveRelease(String(input.setup.majorVersion))
      .pipe(Effect.mapError(mapCreateError));
    const identity = artifactIdentityFor(runtime, release.version, release.image);
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
    yield* applyRoles(probe, input, rolesSql);
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

export const stackReleaseShadowDatabase = (
  handle: StackShadowAcquiredHandle,
): Effect.Effect<void> => handle.ephemeral.stop.pipe(Effect.ignore);

export const stackWithShadowDatabase = <E, A, E2, R2>(
  input: ShadowSetupInput<E>,
  use: (handle: StackShadowAcquiredHandle) => Effect.Effect<A, E2, R2>,
  opts: StackShadowAcquireOpts = {},
): Effect.Effect<
  A,
  E2 | ShadowDbError | E,
  | R2
  | Output
  | DbConnection
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
  | CommandSettings
> =>
  Effect.acquireUseRelease(stackAcquireShadowDatabase(input, opts), use, (handle) =>
    stackReleaseShadowDatabase(handle),
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
