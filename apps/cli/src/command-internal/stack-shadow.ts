import { scryptSync } from "node:crypto";
import {
  Cause,
  Clock,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Predicate,
  Redacted,
  Result,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  ContainerEngineResolver,
  selectDefaultRuntimeSelection,
  type StackConfig,
  type EffectDatabaseInitialization,
  type StackRuntime,
  type StackRuntimePreference,
  type EffectStack,
  type EffectServiceInstance,
  type ServiceDescriptor,
  type SnapshotDescriptor,
} from "@supabase/stack/effect";
import { Output } from "../shared/output/output.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { DbConnection } from "./db-connection.service.ts";
import { parseConnectionString } from "./db-config.parse.ts";
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
import { StackApi } from "./stack-api.ts";
import { loadStackConfig } from "./stack-config.ts";
import { StackCatalogSetup } from "./stack-catalog-setup.ts";
import { resolveSetupWebhooksEnabled, type SetupDatabaseOptions } from "./db-bootstrap/db-setup.ts";
import type { VaultSecret } from "./vault.ts";

const TAR_PREFIX = "stack-shadow-baseline-";

const ensurePrivateCacheDir = (fs: FileSystem.FileSystem, cacheDir: string) =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(cacheDir, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(
        (cause) =>
          new ShadowDbError({
            message: `failed to create ${cacheDir}: ${cause.message}`,
            reason: "filesystem",
          }),
      ),
    );
    yield* fs.chmod(cacheDir, 0o700).pipe(
      Effect.mapError(
        (cause) =>
          new ShadowDbError({
            message: `failed to set permissions on ${cacheDir}: ${cause.message}`,
            reason: "filesystem",
          }),
      ),
    );
  });

export const stackShadowBaselineTarFileName = (key: string): string => `${TAR_PREFIX}${key}.tar`;

const isStackShadowBaselineTar = (fileName: string): boolean =>
  /^stack-shadow-baseline-[0-9a-f]{16}\.tar$/u.test(fileName);

export function isStackShadowBaselinePartial(fileName: string): boolean {
  return /^stack-shadow-baseline-[0-9a-f]{16}\.tar\.[0-9a-f-]+\.partial$/u.test(fileName);
}

export interface StackShadowCacheKeyInputs {
  readonly artifactIdentity: string;
  readonly runtimeIdentity: string;
  readonly bootstrapRecipeId: string;
  readonly bootstrapInputsId: string;
  readonly initializationProfileId: string;
  /** Resolved catalog recipes supplied by the stack descriptor. */
  readonly initialization: {
    readonly profileId: string;
    readonly recipes: ReadonlyArray<{
      readonly service: string;
      readonly recipeId: string;
      readonly artifactIdentity: string;
    }>;
  };
  /** CLI-owned overlay inputs applied after the stack baseline. */
  readonly rolesSql: string;
  readonly webhooksEnabled: boolean;
  readonly apiGrantsKept: boolean;
  readonly vault: ReadonlyArray<VaultSecret>;
  readonly jwks: string;
  readonly storageTargetMigration: string;
}

export const stackShadowCacheKey = (inputs: StackShadowCacheKeyInputs): string => {
  const quoted = (value: string) => JSON.stringify(value);
  const lines: Array<string> = [
    `artifact=${quoted(inputs.artifactIdentity)}`,
    `runtime_identity=${quoted(inputs.runtimeIdentity)}`,
    `bootstrap_recipe=${quoted(inputs.bootstrapRecipeId)}`,
    `bootstrap_inputs=${quoted(inputs.bootstrapInputsId)}`,
    `initialization_profile=${quoted(inputs.initializationProfileId)}`,
    `initialization=${canonicalJson(inputs.initialization)}`,
    `api_grants_kept=${inputs.apiGrantsKept}`,
    `webhooks_enabled=${inputs.webhooksEnabled}`,
    `realtime_jwks=${quoted(inputs.jwks)}`,
    `storage_target_migration=${quoted(inputs.storageTargetMigration)}`,
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

export interface StackShadowAcquiredHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly artifactIdentity: string;
  readonly runtimeIdentity: string;
  readonly bootstrapRecipeId: string;
  readonly bootstrapInputsId: string;
  readonly initializationProfileId: string;
  readonly runtime: StackRuntime;
  readonly baselinePresent: boolean;
  readonly snapshotKey?: string;
  readonly snapshotDescriptor?: SnapshotDescriptor;
  readonly stack: EffectStack;
  readonly service: EffectServiceInstance<"database">;
}

export interface StackShadowAcquireOpts {
  readonly bypassCache?: boolean;
  readonly runtime?: StackRuntimePreference;
  readonly webhooks?: SetupDatabaseOptions["webhooks"];
  /** Optional resolved primary baseline inputs used by database-only reset. */
  readonly database?: {
    readonly version: string;
    readonly settings: NonNullable<
      Exclude<
        NonNullable<NonNullable<StackConfig["capabilities"]>["database"]>,
        { enabled: false }
      >["settings"]
    >;
    readonly initialization?: EffectDatabaseInitialization;
  };
  /** Skips CLI overlays when the caller is producing a catalog-only baseline. */
  readonly applyOverlay?: boolean;
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

// A disabled capability carries no nested pins, so re-enabling one for setup compiles defaults.
const overlaySetupEnabled = <C extends { readonly enabled?: boolean } | undefined>(
  current: C,
  enabled: boolean,
): C | { readonly enabled: false } | { readonly enabled: true } => {
  if (!enabled) return { enabled: false };
  if (current === undefined) return { enabled: true };
  return { ...current, enabled: true };
};

const overlaySetupTrio = (
  config: StackConfig,
  setup: {
    readonly authEnabledForSetup: boolean;
    readonly storageEnabledForSetup: boolean;
    readonly realtimeEnabledForSetup: boolean;
  },
): StackConfig => ({
  ...config,
  capabilities: {
    ...config.capabilities,
    auth: overlaySetupEnabled(config.capabilities?.auth, setup.authEnabledForSetup),
    storage: overlaySetupEnabled(config.capabilities?.storage, setup.storageEnabledForSetup),
    realtime: overlaySetupEnabled(config.capabilities?.realtime, setup.realtimeEnabledForSetup),
  },
});

const loadShadowCatalogConfig = (
  input: ShadowSetupInput<unknown>,
): Effect.Effect<
  StackConfig,
  ShadowDbError,
  FileSystem.FileSystem | Path.Path | RuntimeInfo | Crypto.Crypto
> =>
  loadStackConfig(input.workdir, { context: input.context }).pipe(
    Effect.map((config) => overlaySetupTrio(config, input.setup)),
    Effect.mapError((cause) => new ShadowDbError({ message: cause.message, reason: "filesystem" })),
  );

const applyColdCatalog = (
  stack: EffectStack,
  service: EffectServiceInstance<"database">,
  input: ShadowSetupInput<unknown>,
  webhooks: SetupDatabaseOptions["webhooks"],
): Effect.Effect<
  void,
  ShadowDbError,
  FileSystem.FileSystem | Path.Path | Output | RuntimeInfo | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const catalog = yield* Effect.serviceOption(StackCatalogSetup);
    if (Option.isNone(catalog))
      return yield* new ShadowDbError({
        message: "stack catalog setup is unavailable",
        reason: "database",
      });
    const config = yield* loadShadowCatalogConfig(input);
    yield* catalog.value
      .apply({
        target: {
          kind: "service",
          stack,
          service,
          projectRoot: input.workdir,
        },
        config,
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
  operationId: string,
): Effect.Effect<void, ShadowDbError, R> =>
  Effect.gen(function* () {
    if (skipIfPublished) {
      const published = yield* fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
      if (published) return;
    }
    yield* ensurePrivateCacheDir(fs, cacheDir);
    const tempPath = `${tarPath}.${operationId}.partial`;
    yield* Effect.gen(function* () {
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
      yield* fs.link(tempPath, tarPath).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Predicate.isTagged(cause.reason, "AlreadyExists")
            ? Effect.void
            : Effect.fail(
                new ShadowDbError({
                  message: `failed to publish ${tarPath}: ${cause.message}`,
                  reason: "filesystem",
                }),
              ),
        ),
      );
      yield* fs.remove(tempPath).pipe(
        Effect.mapError(
          (cause) =>
            new ShadowDbError({
              message: `failed to remove temporary shadow baseline ${tempPath}: ${cause.message}`,
              reason: "filesystem",
            }),
        ),
      );
    }).pipe(Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignore)));
    yield* sweepCache(fs, path, cacheDir, path.basename(tarPath));
  });

const mapCreateError = (cause: unknown): ShadowDbError =>
  new ShadowDbError({
    message:
      typeof cause === "object" && cause !== null && "message" in cause
        ? String(Reflect.get(cause, "message"))
        : String(cause),
    reason: "database",
  });

const credentialValue = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value);

const shadowDatabaseSettings = (value: unknown): Record<string, string | number | boolean> => {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
};

const shadowServiceName = (id: string): string => `shadow-${id}`;

const requiredDescriptorValue = (
  value: string | undefined,
  field: string,
): Effect.Effect<string, ShadowDbError> =>
  value === undefined || value.length === 0
    ? Effect.fail(
        new ShadowDbError({
          message: `shadow database descriptor is missing ${field}`,
          reason: "database",
        }),
      )
    : Effect.succeed(value);

const resolvedShadowDescriptor = (
  descriptor: ServiceDescriptor<"database">,
): Effect.Effect<
  {
    readonly artifactIdentity: string;
    readonly runtimeIdentity: string;
    readonly bootstrapRecipeId: string;
    readonly bootstrapInputsId: string;
    readonly initializationProfileId: string;
    readonly initialization: StackShadowCacheKeyInputs["initialization"];
  },
  ShadowDbError
> =>
  Effect.gen(function* () {
    const artifactIdentity = yield* requiredDescriptorValue(
      descriptor.artifactIdentity,
      "artifact identity",
    );
    const runtimeIdentity = yield* requiredDescriptorValue(
      descriptor.runtimeIdentity,
      "runtime identity",
    );
    const bootstrapRecipeId = yield* requiredDescriptorValue(
      descriptor.bootstrapRecipeId,
      "bootstrap recipe identity",
    );
    const bootstrapInputsId = yield* requiredDescriptorValue(
      descriptor.bootstrapInputsId,
      "bootstrap input identity",
    );
    const initializationProfileId = yield* requiredDescriptorValue(
      descriptor.initializationProfileId ?? undefined,
      "initialization profile identity",
    );
    const initialization = descriptor.initialization;
    if (initialization === undefined || initialization.profileId !== initializationProfileId)
      return yield* new ShadowDbError({
        message: "shadow database descriptor has incomplete initialization metadata",
        reason: "database",
      });
    return {
      artifactIdentity,
      runtimeIdentity,
      bootstrapRecipeId,
      bootstrapInputsId,
      initializationProfileId,
      initialization: {
        profileId: initialization.profileId,
        recipes: initialization.recipes.map(
          ({ service, recipeId, artifactIdentity: recipeArtifact }) => ({
            service,
            recipeId,
            artifactIdentity: recipeArtifact,
          }),
        ),
      },
    };
  });

const shadowHandleFor = (
  stack: EffectStack,
  service: EffectServiceInstance<"database">,
  descriptor: ServiceDescriptor<"database">,
  runtime: StackRuntime,
  baselinePresent: boolean,
  snapshotKey: string | undefined,
  snapshotDescriptor: SnapshotDescriptor | undefined,
): Effect.Effect<StackShadowAcquiredHandle, ShadowDbError> =>
  Effect.gen(function* () {
    const metadata = yield* resolvedShadowDescriptor(descriptor);
    const credentials = yield* service.credentials.pipe(Effect.mapError(mapCreateError));
    if (credentials === undefined)
      return yield* new ShadowDbError({
        message: "shadow database credentials are unavailable",
        reason: "database",
      });
    const url = credentialValue(credentials.url);
    const parsed = new URL(url);
    return {
      url,
      host: parsed.hostname,
      port: Number(parsed.port),
      artifactIdentity: metadata.artifactIdentity,
      runtimeIdentity: metadata.runtimeIdentity,
      bootstrapRecipeId: metadata.bootstrapRecipeId,
      bootstrapInputsId: metadata.bootstrapInputsId,
      initializationProfileId: metadata.initializationProfileId,
      runtime,
      baselinePresent,
      ...(snapshotKey === undefined ? {} : { snapshotKey }),
      ...(snapshotDescriptor === undefined ? {} : { snapshotDescriptor }),
      stack,
      service,
    };
  });

const isSnapshotOperation = (kind: string | undefined): boolean =>
  kind === "exportSnapshot" || kind === "restoreSnapshot";

/**
 * A snapshot call can outlive its caller while the supervisor settles its owned operation. The
 * service stream publishes its initial status after subscribing, so this observes that initial
 * state and any completion transition without a status polling loop.
 */
const awaitPendingSnapshotSettlement = (
  service: EffectServiceInstance<"database">,
): Effect.Effect<void, ShadowDbError> =>
  service.followStatus.pipe(
    Stream.filter(
      (status) =>
        status.recovery !== undefined || !isSnapshotOperation(status.pendingOperation?.kind),
    ),
    Stream.runHead,
    Effect.flatMap((settled) =>
      Option.isSome(settled)
        ? Effect.void
        : Effect.fail(
            new ShadowDbError({
              message: `shadow service ${service.id} disappeared before its snapshot operation settled`,
              reason: "database",
            }),
          ),
    ),
    Effect.mapError((cause) =>
      cause instanceof ShadowDbError
        ? cause
        : new ShadowDbError({
            message: `failed to observe shadow service ${service.id} cleanup state: ${String(cause)}`,
            reason: "database",
          }),
    ),
  );

const destroyShadowService = (
  service: EffectServiceInstance<"database">,
): Effect.Effect<void, ShadowDbError> =>
  awaitPendingSnapshotSettlement(service).pipe(
    Effect.andThen(
      service.destroy.pipe(
        Effect.mapError(
          (cause) =>
            new ShadowDbError({
              message: `failed to destroy shadow service ${service.id}: ${mapCreateError(cause).message}`,
              reason: "database",
            }),
        ),
      ),
    ),
  );

/** Releases a CLI owned shadow after any in-flight snapshot has settled. */
export const stackReleaseShadowDatabase = (
  handle: StackShadowAcquiredHandle,
): Effect.Effect<void, ShadowDbError> => destroyShadowService(handle.service);

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
  | RuntimeInfo
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
  | StackApi
> => {
  return Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() =>
      Effect.gen(function* () {
        let ownedService: EffectServiceInstance<"database"> | undefined;
        const acquire = Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const api = yield* StackApi;
          const output = yield* Output;
          const project = yield* api
            .findStack({ projectRoot: input.workdir })
            .pipe(Effect.mapError(mapCreateError));
          const projectRuntime = Option.isSome(project) ? project.value.runtime : undefined;
          if (
            projectRuntime !== undefined &&
            opts.runtime !== undefined &&
            (projectRuntime.kind !== opts.runtime.kind ||
              (projectRuntime.kind === "container" &&
                opts.runtime.kind === "container" &&
                opts.runtime.engine !== undefined &&
                projectRuntime.engine !== opts.runtime.engine))
          )
            return yield* new ShadowDbError({
              message: "The existing stack runtime does not match the requested shadow runtime",
              reason: "database",
            });
          const preference = runtimePreference(projectRuntime, opts.runtime);
          const selected: {
            readonly runtime: StackRuntime;
            readonly dockerFallbackNotice?: string;
          } =
            preference === undefined
              ? yield* selectDefaultRuntimeSelection(
                  Option.getOrUndefined(yield* Effect.serviceOption(ContainerEngineResolver)),
                ).pipe(Effect.mapError(mapCreateError))
              : {
                  runtime:
                    preference.kind === "container"
                      ? { kind: "container", engine: preference.engine ?? "docker" }
                      : { kind: "native" },
                };
          if (selected.dockerFallbackNotice !== undefined)
            yield* output.raw(`${selected.dockerFallbackNotice}\n`, "stderr");
          const runtime = selected.runtime;
          const applyOverlay = opts.applyOverlay !== false;
          const rolesSql = applyOverlay
            ? yield* readRolesSql(input.fs, input.path, input.workdir)
            : "";
          const cacheOn = cacheEnabled(input.setup.projectEnvValues, opts.bypassCache === true);
          const cacheDir = shadowBaselineCacheDir(path);
          const webhooks = applyOverlay ? opts.webhooks : undefined;
          yield* ensurePrivateCacheDir(fs, cacheDir);

          const descriptorConfig = yield* loadShadowCatalogConfig(input);
          const stack = Option.isSome(project)
            ? yield* api.openStack(project.value.id).pipe(Effect.mapError(mapCreateError))
            : yield* api
                .createStack({
                  projectRoot: input.workdir,
                  runtime:
                    runtime.kind === "container"
                      ? { kind: "container", engine: runtime.engine }
                      : { kind: "native" },
                  initialConfig: descriptorConfig,
                })
                .pipe(Effect.mapError(mapCreateError));
          const actualStatus = yield* stack.status.pipe(Effect.mapError(mapCreateError));
          const actualRuntime = actualStatus.runtime;
          const initialization =
            opts.database?.initialization ??
            (yield* stack.services.get({ name: "database" }).pipe(
              Effect.mapError(mapCreateError),
              Effect.flatMap((primary) =>
                primary.service === "database"
                  ? Effect.succeed({ from: primary.id } satisfies EffectDatabaseInitialization)
                  : Effect.fail(
                      new ShadowDbError({
                        message: "the stack primary service is not a database",
                        reason: "database",
                      }),
                    ),
              ),
            ));
          const nameToken = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(
            Effect.mapError(mapCreateError),
          );
          const createShadowService = (name: string) => {
            const options = {
              service: "database" as const,
              name,
              config: {
                enabled: true as const,
                activation: "eager" as const,
                version: opts.database?.version ?? String(input.setup.majorVersion),
                settings: opts.database?.settings ?? {
                  settings: shadowDatabaseSettings(input.db.settings),
                },
                password: Redacted.make(input.password),
                endpoints: { sql: { port: "auto" as const } },
              },
              initialization: initialization,
            };
            return stack.services.create(options).pipe(
              Effect.catchTag("UncertainOperationError", (uncertain) =>
                stack.services.get({ name }).pipe(
                  Effect.flatMap((candidate) => {
                    if (candidate.service !== "database") return Effect.fail(uncertain);
                    return Effect.gen(function* () {
                      const descriptor = yield* candidate.describe;
                      const expectedCreationInputsId = uncertain.expectedCreationInputsId;
                      if (
                        expectedCreationInputsId === undefined ||
                        descriptor.creationInputsId !== expectedCreationInputsId ||
                        descriptor.name !== name ||
                        descriptor.service !== options.service ||
                        !descriptor.enabled ||
                        descriptor.config.activation !== "eager" ||
                        descriptor.config.idleTimeoutSeconds !== false ||
                        descriptor.artifactIdentity === undefined ||
                        descriptor.runtimeIdentity === undefined
                      )
                        return yield* uncertain;
                      const actualEndpoint = descriptor.endpoints.sql;
                      if (actualEndpoint === undefined) return yield* uncertain;
                      const credentials = yield* candidate.credentials;
                      if (credentials === undefined) return yield* uncertain;
                      if (credentialValue(credentials.password) !== input.password)
                        return yield* uncertain;
                      const password = yield* Effect.try({
                        try: () =>
                          decodeURIComponent(new URL(credentialValue(credentials.url)).password),
                        catch: () => undefined,
                      });
                      if (password !== input.password) return yield* uncertain;
                      if (
                        descriptor.initializationProfileId == null ||
                        descriptor.initializationProfileId.length === 0 ||
                        descriptor.bootstrapRecipeId === undefined ||
                        descriptor.bootstrapRecipeId.length === 0 ||
                        descriptor.bootstrapInputsId === undefined ||
                        descriptor.bootstrapInputsId.length === 0 ||
                        descriptor.initialization?.profileId !== descriptor.initializationProfileId
                      )
                        return yield* uncertain;
                      return candidate;
                    });
                  }),
                  Effect.mapError(() => uncertain),
                ),
              ),
              Effect.mapError(mapCreateError),
            );
          };
          const createAndRegister = (name: string) =>
            Effect.uninterruptibleMask((restoreCreate) =>
              Effect.gen(function* () {
                const created = yield* restoreCreate(createShadowService(name));
                ownedService = created;
                return created;
              }),
            );
          let service = yield* createAndRegister(shadowServiceName(nameToken));
          let exportOperationId = nameToken;
          const descriptor = yield* service.describe.pipe(Effect.mapError(mapCreateError));
          const metadata = yield* resolvedShadowDescriptor(descriptor);
          const jwks =
            input.setup.realtimeEnabledForSetup && input.setup.majorVersion >= 15
              ? yield* input.setup.jwks
              : "";
          if (!cacheOn) {
            yield* service.start.pipe(Effect.mapError(mapCreateError));
            if (applyOverlay) yield* applyColdCatalog(stack, service, input, webhooks);
            const handle = yield* shadowHandleFor(
              stack,
              service,
              descriptor,
              actualRuntime,
              false,
              undefined,
              undefined,
            );
            return handle;
          }
          const key = stackShadowCacheKey({
            artifactIdentity: metadata.artifactIdentity,
            runtimeIdentity: metadata.runtimeIdentity,
            bootstrapRecipeId: metadata.bootstrapRecipeId,
            bootstrapInputsId: metadata.bootstrapInputsId,
            initializationProfileId: metadata.initializationProfileId,
            initialization: metadata.initialization,
            rolesSql,
            webhooksEnabled: applyOverlay
              ? resolveSetupWebhooksEnabled(webhooks, input.setup.webhooksEnabled)
              : false,
            apiGrantsKept: applyOverlay
              ? Option.getOrElse(input.setup.apiAutoExposeNewTables, () => true)
              : true,
            vault: applyOverlay ? input.setup.vault : [],
            jwks: applyOverlay ? jwks : "",
            storageTargetMigration: applyOverlay ? input.setup.storageTargetMigration : "",
          });
          const tarName = stackShadowBaselineTarFileName(key);
          const tarPath = path.join(cacheDir, tarName);
          let cached = yield* fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
          yield* sweepCache(fs, path, cacheDir, tarName);

          if (cached) {
            const restored = yield* Effect.result(
              service.restoreSnapshot({ source: tarPath }).pipe(Effect.mapError(mapCreateError)),
            );
            if (Result.isSuccess(restored)) {
              yield* service.start.pipe(Effect.mapError(mapCreateError));
              yield* touchShadowBaselineTar(fs, tarPath);
              const handle = yield* shadowHandleFor(
                stack,
                service,
                descriptor,
                actualRuntime,
                true,
                key,
                restored.success,
              );
              return handle;
            }
            yield* destroyShadowService(service);
            yield* Effect.uninterruptible(Effect.sync(() => (ownedService = undefined)));
            yield* fs.remove(tarPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ShadowDbError({
                    message: `failed to remove invalid shadow baseline ${tarPath}: ${cause.message}`,
                    reason: "filesystem",
                  }),
              ),
            );
            cached = false;
            const output = yield* Output;
            yield* output.raw(
              `Warning: shadow baseline not cached: ${restored.failure.message}\n`,
              "stderr",
            );
            const replacementToken = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(
              Effect.mapError(mapCreateError),
            );
            exportOperationId = replacementToken;
            service = yield* createAndRegister(shadowServiceName(replacementToken));
          }

          yield* service.start.pipe(Effect.mapError(mapCreateError));
          if (applyOverlay) yield* applyColdCatalog(stack, service, input, webhooks);
          let exportedDescriptor: SnapshotDescriptor | undefined;
          const exported = yield* Effect.result(
            Effect.gen(function* () {
              const rolesSqlNow = applyOverlay
                ? yield* readRolesSql(input.fs, input.path, input.workdir)
                : "";
              if (rolesSqlNow !== rolesSql) {
                return yield* new ShadowDbError({
                  message: "supabase/roles.sql changed during provisioning",
                  reason: "filesystem",
                });
              }
              yield* service.stop.pipe(Effect.mapError(mapCreateError));
              yield* writeStackShadowBaselineTar(
                fs,
                path,
                cacheDir,
                tarPath,
                (tempPath) =>
                  service.exportSnapshot({ destination: tempPath }).pipe(
                    Effect.tap((snapshot) => Effect.sync(() => (exportedDescriptor = snapshot))),
                    Effect.mapError(mapCreateError),
                    Effect.asVoid,
                  ),
                !cached,
                exportOperationId,
              );
            }),
          );
          // A transport failure may leave exportSnapshot admitted in the supervisor. Wait for its
          // owner to publish a terminal state before attempting to wake the instance.
          yield* awaitPendingSnapshotSettlement(service);
          yield* service.start.pipe(Effect.mapError(mapCreateError));
          if (Result.isFailure(exported)) {
            const output = yield* Output;
            yield* output.raw(
              `Warning: shadow baseline not cached: ${exported.failure.message}\n`,
              "stderr",
            );
          }
          const handle = yield* shadowHandleFor(
            stack,
            service,
            descriptor,
            actualRuntime,
            false,
            Result.isSuccess(exported) ? key : undefined,
            exportedDescriptor,
          );
          return handle;
        }).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit) || ownedService === undefined) return Effect.void;
            const service = ownedService;
            return Effect.uninterruptible(destroyShadowService(service));
          }),
        );
        const result = yield* restore(acquire);
        ownedService = undefined;
        return result;
      }),
    ),
  );
};

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
  | RuntimeInfo
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
  | StackApi
> =>
  // Keep only the ownership handoff and cleanup uninterruptible. `acquireUseRelease` masks its
  // whole acquisition, which would also mask the supervisor startup and snapshot work.
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const acquired = yield* restore(Effect.exit(stackAcquireShadowDatabase(input, opts)));
      if (Exit.isFailure(acquired)) return yield* Effect.failCause(acquired.cause);
      const used = yield* restore(Effect.exit(use(acquired.value)));
      const released = yield* Effect.exit(destroyShadowService(acquired.value.service));
      if (Exit.isFailure(used) && Exit.isFailure(released))
        return yield* Effect.failCause(Cause.combine(used.cause, released.cause));
      if (Exit.isFailure(released)) return yield* Effect.failCause(released.cause);
      return yield* used;
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
      const credentials = yield* handle.service.credentials.pipe(Effect.mapError(mapCreateError));
      if (credentials === undefined)
        return yield* new ShadowDbError({
          message: "shadow database credentials are unavailable",
          reason: "database",
        });
      const conn = parseConnectionString(credentialValue(credentials.url));
      if (conn === undefined)
        return yield* new ShadowDbError({
          message: "failed to parse shadow database URL",
          reason: "connect",
        });
      const session = yield* connectShadowDatabase(conn);
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
