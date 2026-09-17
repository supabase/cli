import { Data, Effect, FileSystem, Option, Path, Redacted } from "effect";
import { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import {
  CAPABILITY_NAMES,
  excludeStackCapabilities,
  type EffectStack,
  type StackConfig,
  type StackRuntime,
  type StackStatus,
} from "@supabase/stack/effect";
import { parseConnectionString } from "./db-config.parse.ts";
import { DbConnection, type DbSession, type PgConnInput } from "./db-connection.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { LocalDbRunningError } from "./db-bootstrap/local-db-running.ts";
import { applyDatabaseWebhooks } from "./db-bootstrap/db-setup.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { StackApi } from "./stack-api.ts";
import { loadStackConfig } from "./stack-config.ts";
import { readDbToml, type DbTomlValues } from "./db-config.toml-read.ts";
import { StackCatalogSetup } from "./stack-catalog-setup.ts";
import { resolveExperimentalWithProjectEnv } from "./global-flags.ts";
import { migrateAndSeed } from "./migrate-and-seed.ts";

const stackDatabaseConn = (stack: EffectStack) =>
  Effect.gen(function* () {
    const credentials = yield* stack.credentials;
    const conn = parseConnectionString(Redacted.value(credentials.database.url));
    if (conn === undefined)
      return yield* Effect.fail({ message: "failed to parse stack database URL" });
    return conn;
  });

const withStackDatabaseSession = <A, E, R>(
  stack: EffectStack,
  body: (session: DbSession) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dbConn = yield* DbConnection;
      const conn = yield* stackDatabaseConn(stack);
      const session = yield* dbConn.connect(conn, { isLocal: true, dnsResolver: "native" });
      return yield* body(session);
    }),
  );

/** Webhooks-only setup for an existing cluster. */
export const applyStackWebhooksOnly = (
  stack: EffectStack,
  webhooksEnabled: boolean,
): Effect.Effect<
  void,
  { readonly message: string },
  DbConnection | FileSystem.FileSystem | Path.Path
> =>
  withStackDatabaseSession(stack, (session) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-webhooks-" });
      yield* applyDatabaseWebhooks(session, fs, path, tmpDir, webhooksEnabled);
    }),
  ).pipe(
    Effect.mapError((error) =>
      typeof error === "object" && error !== null && "message" in error
        ? { message: String(error.message) }
        : { message: String(error) },
    ),
  );

/** First-create migrate and seed after schema init and catalog overlay. */
export const applyStackMigrateAndSeed = (
  stack: EffectStack,
  workdir: string,
  toml: Pick<
    DbTomlValues,
    "migrationsEnabled" | "seed" | "pgDelta" | "schemaPaths" | "webhooksEnabled"
  >,
  experimental: boolean,
): Effect.Effect<
  void,
  { readonly message: string },
  DbConnection | FileSystem.FileSystem | Path.Path | Output
> =>
  withStackDatabaseSession(stack, (session) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* migrateAndSeed(session, fs, path, workdir, "", {
        migrationsEnabled: toml.migrationsEnabled,
        seed: toml.seed,
        experimental,
        pgDeltaEnabled: toml.pgDelta.enabled,
        schemaPaths: toml.schemaPaths,
        localDatabaseWebhooksEnabled: toml.webhooksEnabled,
      });
    }),
  ).pipe(
    Effect.mapError((error) =>
      typeof error === "object" && error !== null && "message" in error
        ? { message: String(error.message) }
        : { message: String(error) },
    ),
  );

const notRunning = (message = "The local stack is not running.") =>
  new LocalDbRunningError({ message });

const startFailed = (cause: { readonly message: string }) =>
  new LocalDbRunningError({
    message: `failed to start local database: ${cause.message}`,
  });

const startFailedAfterEngine = (cause: { readonly message: string }) =>
  startFailed({
    message: `${cause.message}. The stack is running; recover with db reset.`,
  });

/** Capabilities `db start` and `stack start --exclude` can leave disabled. */
export const STACK_START_EXCLUDABLE_CAPABILITIES = CAPABILITY_NAMES.filter(
  (name) => name !== "database",
);

const postgresOnlyStackStartConfig = (config: StackConfig): StackConfig =>
  excludeStackCapabilities(config, STACK_START_EXCLUDABLE_CAPABILITIES);

/** Optional catalog jobs follow the running definition, not full TOML. */
export const optionalCatalogConfigFromStatus = (
  config: StackConfig,
  status: Pick<StackStatus, "capabilities">,
): StackConfig =>
  excludeStackCapabilities(
    config,
    STACK_START_EXCLUDABLE_CAPABILITIES.filter(
      (name) =>
        status.capabilities.find((capability) => capability.name === name)?.state === "disabled",
    ),
  );

const databaseReady = (stack: EffectStack) =>
  Effect.gen(function* () {
    const status = yield* stack.status.pipe(Effect.mapError((cause) => notRunning(cause.message)));
    const database = status.capabilities.find((capability) => capability.name === "database");
    if (status.lifecycle !== "running" || database?.state !== "ready") return Option.none();
    return Option.some({ stack, runtime: status.runtime });
  });

/**
 * Finds and opens the registered project stack, or `None` when the stack API is unavailable or
 * no stack is registered for this project. `onFailure` maps the underlying find/open failure to
 * the caller's own error type.
 */
export const stackOpenProjectBy = <E>(
  onFailure: (cause: { readonly message: string }) => E,
): Effect.Effect<Option.Option<EffectStack>, E, CommandSettings> =>
  Effect.gen(function* () {
    const api = yield* Effect.serviceOption(StackApi);
    if (Option.isNone(api)) return Option.none();
    const cliSettings = yield* CommandSettings;
    const descriptor = yield* api.value
      .findStack({ projectRoot: cliSettings.workdir })
      .pipe(Effect.mapError((cause) => onFailure(cause)));
    if (Option.isNone(descriptor)) return Option.none();
    const stack = yield* api.value
      .openStack(descriptor.value.id)
      .pipe(Effect.mapError((cause) => onFailure(cause)));
    return Option.some(stack);
  });

/** Ready project stack, or none when the stack is missing or the database is not ready. */
export const stackOpenReadyProject = stackOpenProjectBy((cause) => notRunning(cause.message)).pipe(
  Effect.flatMap((opened) =>
    Option.isNone(opened) ? Effect.succeed(Option.none()) : databaseReady(opened.value),
  ),
);

export const stackProjectRuntime: Effect.Effect<StackRuntime | undefined, never, CommandSettings> =
  Effect.gen(function* () {
    const api = yield* Effect.serviceOption(StackApi);
    if (Option.isNone(api)) return undefined;
    const cliSettings = yield* CommandSettings;
    const descriptor = yield* api.value
      .findStack({ projectRoot: cliSettings.workdir })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.match(descriptor, {
      onNone: () => undefined,
      onSome: (value) => value.runtime,
    });
  });

export class StackRuntimeUnavailableError extends Data.TaggedError("StackRuntimeUnavailableError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

const RUNTIME_UNAVAILABLE = new StackRuntimeUnavailableError({
  message: "Could not determine the stack runtime.",
  suggestion: "Start the stack, or start with --runtime docker.",
});

/** Fail instead of treating an unknown engine as Docker. */
export const stackRequireProjectRuntime: Effect.Effect<
  StackRuntime,
  StackRuntimeUnavailableError,
  CommandSettings
> = Effect.gen(function* () {
  const api = yield* Effect.serviceOption(StackApi);
  if (Option.isNone(api)) return yield* RUNTIME_UNAVAILABLE;
  const cliSettings = yield* CommandSettings;
  const descriptor = yield* api.value.findStack({ projectRoot: cliSettings.workdir }).pipe(
    Effect.mapError(
      (cause) =>
        new StackRuntimeUnavailableError({
          message: cause.message,
          suggestion: RUNTIME_UNAVAILABLE.suggestion,
        }),
    ),
  );
  if (Option.isNone(descriptor)) return yield* RUNTIME_UNAVAILABLE;
  return descriptor.value.runtime;
});

/** Catalog pin from `status().versions.database`, when the project stack is available. */
export const stackProjectDatabaseVersion: Effect.Effect<
  string | undefined,
  never,
  CommandSettings
> = Effect.gen(function* () {
  const api = yield* Effect.serviceOption(StackApi);
  if (Option.isNone(api)) return undefined;
  const cliSettings = yield* CommandSettings;
  const descriptor = yield* api.value
    .findStack({ projectRoot: cliSettings.workdir })
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(descriptor)) return undefined;
  const stack = yield* api.value
    .openStack(descriptor.value.id)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (stack === undefined) return undefined;
  const status = yield* stack.status.pipe(Effect.orElseSucceed(() => undefined));
  if (status === undefined || typeof status.versions.database !== "string") return undefined;
  return status.versions.database;
});

const STACK_NATIVE_ENGINE_MESSAGE = "The stack backend only supports the pg-delta engine.";

const stackNativeEngineAdvice = (flag: string) =>
  `${STACK_NATIVE_ENGINE_MESSAGE} Do not pass ${flag}; set SUPABASE_EXPERIMENTAL_STACK=0.`;

export class StackNativeEngineError extends Data.TaggedError("StackNativeEngineError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export const stackRejectNativeDockerDiffEngine = (
  flag: string,
): Effect.Effect<void, StackNativeEngineError> =>
  Effect.gen(function* () {
    const backend = yield* currentStackBackend;
    if (backend.kind !== "stack") return;
    return yield* new StackNativeEngineError({ message: stackNativeEngineAdvice(flag) });
  });

const stackLocalDatabaseUrl: Effect.Effect<string, LocalDbRunningError, CommandSettings> =
  Effect.gen(function* () {
    const opened = yield* stackOpenReadyProject;
    if (Option.isNone(opened)) return yield* notRunning();
    const credentials = yield* opened.value.stack.credentials.pipe(
      Effect.mapError((cause) => notRunning(cause.message)),
    );
    return Redacted.value(credentials.database.url);
  });

export const stackLocalDatabaseConn: Effect.Effect<
  PgConnInput,
  LocalDbRunningError,
  CommandSettings
> = Effect.gen(function* () {
  const url = yield* stackLocalDatabaseUrl;
  const conn = parseConnectionString(url);
  if (conn === undefined) {
    return yield* notRunning(`failed to parse stack database URL`);
  }
  return conn;
});

/** Postgres-only `db start` / resume path. */
export const stackEnsurePostgresOnlyStarted = Effect.gen(function* () {
  const api = yield* Effect.serviceOption(StackApi);
  if (Option.isNone(api)) return yield* startFailed({ message: "stack API is unavailable" });
  const cliSettings = yield* CommandSettings;
  const output = yield* Output;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* loadStackConfig(cliSettings.workdir).pipe(Effect.mapError(startFailed));
  const toml = yield* readDbToml(fs, path, cliSettings.workdir).pipe(Effect.mapError(startFailed));
  const experimental = yield* resolveExperimentalWithProjectEnv({ ...toml.projectEnv });
  const applyCatalog = (stack: EffectStack) =>
    Effect.gen(function* () {
      const catalog = yield* Effect.serviceOption(StackCatalogSetup);
      if (Option.isNone(catalog))
        return yield* startFailedAfterEngine({ message: "stack catalog setup is unavailable" });
      yield* catalog.value
        .apply({
          target: {
            kind: "live",
            stack,
            projectRoot: cliSettings.workdir,
            config,
          },
          optionalConfig: postgresOnlyStackStartConfig(config),
          overlay: {
            webhooks: "config",
            webhooksEnabled: toml.webhooksEnabled,
            apiAutoExposeNewTables: toml.baseline.apiAutoExposeNewTables,
            vault: toml.vault,
            workdir: cliSettings.workdir,
          },
        })
        .pipe(Effect.mapError(startFailedAfterEngine));
    });
  const existing = yield* api.value
    .findStack({ projectRoot: cliSettings.workdir })
    .pipe(Effect.mapError(startFailed));
  if (Option.isNone(existing) || existing.value.desiredLifecycle === "unconfigured") {
    const stack = Option.isNone(existing)
      ? yield* api.value
          .createStack({ projectRoot: cliSettings.workdir })
          .pipe(Effect.mapError(startFailed))
      : yield* api.value.openStack(existing.value.id).pipe(Effect.mapError(startFailed));
    if (stack.dockerFallbackNotice !== undefined)
      yield* output.raw(`${stack.dockerFallbackNotice}\n`, "stderr");
    yield* stack
      .start({ config: postgresOnlyStackStartConfig(config) })
      .pipe(Effect.mapError(startFailed));
    yield* applyCatalog(stack);
    yield* applyStackMigrateAndSeed(stack, cliSettings.workdir, toml, experimental).pipe(
      Effect.mapError(startFailedAfterEngine),
    );
    return "started";
  }
  const stack = yield* api.value.openStack(existing.value.id).pipe(Effect.mapError(startFailed));
  const status = yield* stack.status.pipe(Effect.mapError(startFailed));
  const database = status.capabilities.find((capability) => capability.name === "database");
  if (status.lifecycle === "running" && database?.state === "ready") {
    yield* applyStackWebhooksOnly(stack, toml.webhooksEnabled).pipe(
      Effect.mapError(startFailedAfterEngine),
    );
    return "already-running";
  }
  yield* stack.start().pipe(Effect.mapError(startFailed));
  yield* applyStackWebhooksOnly(stack, toml.webhooksEnabled).pipe(
    Effect.mapError(startFailedAfterEngine),
  );
  return "started";
});
