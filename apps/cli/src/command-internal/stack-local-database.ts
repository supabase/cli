import { Data, Effect, FileSystem, Option, Path, Redacted } from "effect";
import type { DatabaseInstance, ServiceCreation, Stack } from "@supabase/stack/effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { LocalDbRunningError } from "./db-bootstrap/local-db-running.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { StackApi } from "./stack-api.ts";
import { loadStackConfig } from "./stack-config.ts";
import { readDbToml } from "./db-config.toml-read.ts";
import { StackCatalogSetup } from "./stack-catalog-setup.ts";
import { resolveExperimentalWithProjectEnv } from "./global-flags.ts";
import { applyStackMigrateAndSeed, applyStackWebhooksOnly } from "./stack-bootstrap.ts";
import { defaultStackRuntime } from "./stack-runtime.ts";
import { Output } from "../shared/output/output.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import type { PgConnInput } from "./db-connection.service.ts";

type Settings = CommandSettings["Service"];

const stateRoot = (settings: Settings, path: Path.Path) =>
  path.join(settings.supabaseHome, "stacks");
const cacheRoot = (settings: Settings, path: Path.Path) =>
  path.join(settings.supabaseHome, "cache", "stack");
const notRunning = (message = "The local stack is not running.") =>
  new LocalDbRunningError({ message });
const startFailed = (cause: { readonly message: string }) =>
  new LocalDbRunningError({ message: `failed to start local database: ${cause.message}` });

type StackInstances = Effect.Success<Stack["services"]["list"]>;

const databaseFor = (instances: StackInstances): DatabaseInstance | undefined =>
  instances.find((instance): instance is DatabaseInstance => instance.service === "database");

const stackForProject = Effect.fn("StackLocalDatabase.findProject")(function* (
  api: StackApi["Service"],
  settings: Settings,
  path: Path.Path,
) {
  const identity = yield* api.resolveIdentity({ projectRoot: settings.workdir });
  const discovered = yield* api.discover({ stateRoot: stateRoot(settings, path) });
  return discovered.find(
    ({ definition }) =>
      definition.identity.projectRoot === identity.projectRoot &&
      definition.identity.branchContext === identity.branchContext &&
      definition.identity.stackName === identity.stackName,
  );
});

const openProjectStack = Effect.fn("StackLocalDatabase.openProject")(function* () {
  const api = yield* StackApi;
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  const found = yield* stackForProject(api, settings, path);
  if (found === undefined) return Option.none<Stack>();
  return Option.some(
    yield* api.open({
      id: found.definition.id,
      stateRoot: stateRoot(settings, path),
      cacheRoot: cacheRoot(settings, path),
    }),
  );
});

const databaseFromStack = Effect.fn("StackLocalDatabase.database")(function* (stack: Stack) {
  const composition = yield* stack.composition.describe;
  const members = yield* Effect.forEach(composition.members, ({ id }) => stack.services.get(id));
  return databaseFor(members);
});

const databaseReady = Effect.fn("StackLocalDatabase.ready")(function* (stack: Stack) {
  const database = yield* databaseFromStack(stack);
  if (database === undefined)
    return Option.none<{ readonly stack: Stack; readonly database: DatabaseInstance }>();
  const observation = yield* database.status.pipe(
    Effect.map(Option.some),
    Effect.catchTag("StackError", () => Effect.succeed(Option.none())),
  );
  if (
    Option.isNone(observation) ||
    observation.value.lifecycle !== "running" ||
    observation.value.health !== "healthy"
  )
    return Option.none();
  return Option.some({ stack, database });
});

/** Finds and opens the registered project stack without starting its owner. */
export const stackOpenProjectBy = <E>(onFailure: (cause: { readonly message: string }) => E) =>
  openProjectStack().pipe(Effect.mapError(onFailure));

/** Returns the project stack only when its primary database is healthy. */
export const stackOpenReadyProject = stackOpenProjectBy((cause) => notRunning(cause.message)).pipe(
  Effect.flatMap((opened) =>
    Option.isNone(opened) ? Effect.succeed(Option.none()) : databaseReady(opened.value),
  ),
);

export const stackProjectRuntime = Effect.gen(function* () {
  const api = yield* StackApi;
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  return (yield* stackForProject(api, settings, path))?.definition.runtime;
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

export const stackRequireProjectRuntime: Effect.Effect<
  "native" | "docker" | "podman",
  StackRuntimeUnavailableError,
  CommandSettings | StackApi | Path.Path
> = stackProjectRuntime.pipe(
  Effect.flatMap((runtime) =>
    runtime === undefined ? Effect.fail(RUNTIME_UNAVAILABLE) : Effect.succeed(runtime),
  ),
  Effect.mapError(
    (cause) =>
      new StackRuntimeUnavailableError({
        message: cause.message,
        suggestion: RUNTIME_UNAVAILABLE.suggestion,
      }),
  ),
);

/** Reads the configured database version from the saved database definition. */
export const stackProjectDatabaseVersion: Effect.Effect<
  string | undefined,
  never,
  CommandSettings | StackApi | Path.Path
> = Effect.gen(function* () {
  const opened = yield* openProjectStack().pipe(
    Effect.mapError(() => undefined),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(opened)) return undefined;
  const database = yield* databaseFromStack(opened.value).pipe(
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );
  if (database === undefined) return undefined;
  const status = yield* database.status.pipe(Effect.option, Effect.map(Option.getOrUndefined));
  return status?.config.service === "database" ? status.config.config.version : undefined;
});

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
    if ((yield* currentStackBackend).kind === "stack")
      return yield* new StackNativeEngineError({
        message: `The stack backend only supports the pg-delta engine. Do not pass ${flag}; set SUPABASE_EXPERIMENTAL_STACK=0.`,
      });
  });

const stackLocalDatabaseUrl: Effect.Effect<
  string,
  LocalDbRunningError,
  CommandSettings | StackApi | Path.Path
> = Effect.gen(function* () {
  const opened = yield* stackOpenReadyProject.pipe(
    Effect.mapError((cause) => notRunning(cause.message)),
  );
  if (Option.isNone(opened)) return yield* notRunning();
  const status = yield* opened.value.database.status.pipe(
    Effect.mapError((cause) => notRunning(cause.message)),
  );
  const endpoint = status.endpoints.find(({ name }) => name === "sql");
  if (status.config.service !== "database")
    return yield* notRunning("The local stack primary service is not a database.");
  if (endpoint === undefined)
    return yield* notRunning("The local stack database SQL endpoint is unavailable.");
  const password = Redacted.value(status.config.config.databasePassword);
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `postgresql://postgres:${encodeURIComponent(password)}@${host}:${endpoint.port}/postgres`;
});

export const stackLocalDatabaseConn: Effect.Effect<
  PgConnInput,
  LocalDbRunningError,
  CommandSettings | StackApi | Path.Path
> = stackLocalDatabaseUrl.pipe(
  Effect.flatMap((url) => {
    const conn = parseConnectionString(url);
    return conn === undefined
      ? Effect.fail(notRunning("failed to parse stack database URL"))
      : Effect.succeed(conn);
  }),
  Effect.mapError((cause) => notRunning(cause.message)),
);

/** Starts or resumes the primary database, initializing the catalog on first creation. */
export const stackEnsurePostgresOnlyStarted = Effect.fn(
  "StackLocalDatabase.ensurePostgresOnlyStarted",
)(function* () {
  const api = yield* StackApi;
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  const runtime = yield* RuntimeInfo;
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const config = yield* loadStackConfig(settings.workdir).pipe(Effect.mapError(startFailed));
  const toml = yield* readDbToml(fs, path, settings.workdir).pipe(Effect.mapError(startFailed));
  const experimental = yield* resolveExperimentalWithProjectEnv({ ...toml.projectEnv });
  const existing = yield* stackForProject(api, settings, path).pipe(Effect.mapError(startFailed));
  const stack =
    existing === undefined
      ? yield* api
          .create({
            projectRoot: settings.workdir,
            stateRoot: stateRoot(settings, path),
            cacheRoot: cacheRoot(settings, path),
            runtime: defaultStackRuntime(runtime),
          })
          .pipe(Effect.mapError(startFailed))
      : yield* api
          .open({
            id: existing.definition.id,
            stateRoot: stateRoot(settings, path),
            cacheRoot: cacheRoot(settings, path),
          })
          .pipe(Effect.mapError(startFailed));
  const currentDatabase = yield* databaseFromStack(stack).pipe(Effect.mapError(startFailed));
  if (currentDatabase !== undefined) {
    if (Option.isSome(yield* databaseReady(stack).pipe(Effect.mapError(startFailed)))) {
      yield* applyStackWebhooksOnly(currentDatabase, toml.webhooksEnabled).pipe(
        Effect.mapError(startFailed),
      );
      return "already-running" as const;
    }
    yield* currentDatabase.start.pipe(Effect.mapError(startFailed));
    yield* currentDatabase.ready.pipe(Effect.mapError(startFailed));
    yield* applyStackWebhooksOnly(currentDatabase, toml.webhooksEnabled).pipe(
      Effect.mapError(startFailed),
    );
    return "started" as const;
  }
  const creations = yield* config.creations(stack.id).pipe(Effect.mapError(startFailed));
  const databaseCreation = creations.find(
    (creation): creation is Extract<ServiceCreation, { service: "database" }> =>
      creation.service === "database",
  );
  if (databaseCreation === undefined)
    return yield* startFailed({ message: "database is disabled in the local configuration" });
  const [database] = yield* stack.composition
    .supabase([databaseCreation])
    .pipe(Effect.mapError(startFailed));
  if (database === undefined || database.service !== "database")
    return yield* startFailed({ message: "stack did not create a database instance" });
  return yield* Effect.gen(function* () {
    yield* database.start.pipe(Effect.mapError(startFailed));
    yield* database.ready.pipe(Effect.mapError(startFailed));
    const catalog = yield* StackCatalogSetup;
    const databaseServices = creations.flatMap((creation) =>
      creation.service === "auth" ||
      creation.service === "storage" ||
      creation.service === "realtime"
        ? [creation.service]
        : [],
    );
    yield* catalog
      .apply({
        target: { stack, database, databaseServices, jwtSecret: Redacted.value(config.jwtSecret) },
        overlay: {
          webhooks: "config",
          webhooksEnabled: toml.webhooksEnabled,
          apiAutoExposeNewTables: toml.baseline.apiAutoExposeNewTables,
          vault: toml.vault,
          workdir: settings.workdir,
        },
      })
      .pipe(Effect.mapError(startFailed));
    yield* applyStackMigrateAndSeed(database, settings.workdir, toml, experimental).pipe(
      Effect.mapError(startFailed),
    );
    return "started" as const;
  }).pipe(
    Effect.onError(() =>
      database.destroy.pipe(
        Effect.tapError((cause) =>
          output.raw(
            `Failed to destroy newly created database ${database.id}: ${cause.message}. Run supabase stack destroy to remove the incomplete stack before retrying.\n`,
            "stderr",
          ),
        ),
        Effect.ignore,
      ),
    ),
  );
});

export { applyStackMigrateAndSeed, applyStackWebhooksOnly } from "./stack-bootstrap.ts";
