import { Data, Effect, FileSystem, Option, Path, Redacted } from "effect";
import type { DatabaseInstance, ServiceCreationInput, Stack } from "@supabase/stack/effect";
import type { ArtifactPin } from "@supabase/stack/internal/artifacts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import { toUserFacingDatabaseUrl } from "./postgres-url.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { LocalDbRunningError } from "./db-bootstrap/local-db-running.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { StackApi } from "./stack-api.ts";
import {
  describeStackSelector,
  selectedStack,
  type StackSelectorFlags,
  StackTargetError,
  StackTargetResolver,
  stackTargetResolverLayer,
} from "./stack-target.ts";
import { loadStackConfig } from "./stack-config.ts";
import { lockedSelection } from "./stack-lock.ts";
import { readDbConfig } from "./db-config.read.ts";
import { catalogDatabaseServices } from "./stack-catalog-setup.ts";
import { resolveExperimentalWithProjectEnv } from "./global-flags.ts";
import {
  applyStackWebhooksOnly,
  initializeStackDatabase,
  projectCatalogOverlay,
} from "./stack-bootstrap.ts";
import { automaticRuntimeNotice, selectStackRuntime, type StackRuntime } from "./stack-runtime.ts";
import { Output } from "../shared/output/output.service.ts";
import type { PgConnInput } from "./db-connection.service.ts";

type Settings = CommandSettings["Service"];

/** What reading the project's selected stack needs. */
type ProjectStackServices =
  | CommandSettings
  | StackApi
  | FileSystem.FileSystem
  | Path.Path
  | StackSelectorFlags;

const stateRoot = (settings: Settings, path: Path.Path) =>
  path.join(settings.supabaseHome, "stacks");
const cacheRoot = (settings: Settings, path: Path.Path) =>
  path.join(settings.supabaseHome, "cache", "stack");
const notRunning = (message = "The local stack is not running.") =>
  new LocalDbRunningError({ message });
const unavailable = (cause: { readonly message: string; readonly suggestion?: string }) =>
  cause instanceof LocalDbRunningError
    ? cause
    : new LocalDbRunningError({
        message: cause.message,
        ...(cause.suggestion === undefined ? {} : { suggestion: cause.suggestion }),
        cause,
      });
const startFailed = (cause: { readonly message: string }) =>
  new LocalDbRunningError({
    message: `failed to start local database: ${cause.message}`,
    cause,
  });

type StackInstances = Effect.Success<Stack["services"]["list"]>;

const databaseFor = (instances: StackInstances): DatabaseInstance | undefined =>
  instances.find((instance): instance is DatabaseInstance => instance.service === "database");

/** A stopped or missing stack that `--stack`/`--stack-id` or `SUPABASE_STACK`/`SUPABASE_STACK_ID` selected. */
const selectedNotRunning = (
  selected: { readonly label: string; readonly flags: string },
  state: string,
) =>
  new LocalDbRunningError({
    message: `The local stack ${selected.label} ${state}.`,
    suggestion: `Run supabase start ${selected.flags}.`,
  });

/**
 * The project's selected stack, or its default stack when nothing selects one. A selected stack
 * that does not exist fails unless `createSelected` (`db start`) will create it.
 */
const stackForProject = Effect.fn("StackLocalDatabase.stackForProject")(function* (
  options: { readonly createSelected?: boolean } = {},
) {
  const settings = yield* CommandSettings;
  const selected = yield* selectedStack;
  const target = yield* Effect.service(StackTargetResolver).pipe(
    Effect.flatMap((resolver) =>
      resolver.resolve({ projectRoot: settings.workdir, runtime: "auto", ...selected }),
    ),
    Effect.provide(stackTargetResolverLayer),
  );
  const named = describeStackSelector(selected);
  if (target.definition === undefined && named !== undefined && options.createSelected !== true)
    return yield* selectedNotRunning(named, "does not exist for this project");
  return { selected, named, saved: target.definition };
});

const openProjectStack = Effect.fn("StackLocalDatabase.openProject")(function* () {
  const api = yield* StackApi;
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  const { named, saved } = yield* stackForProject();
  const stack =
    saved === undefined
      ? Option.none<Stack>()
      : Option.some(
          yield* api.open({
            id: saved.id,
            stateRoot: stateRoot(settings, path),
            cacheRoot: cacheRoot(settings, path),
          }),
        );
  return { named, stack };
});

const databaseFromStack = Effect.fn("StackLocalDatabase.database")(function* (stack: Stack) {
  const composition = yield* stack.composition.describe;
  const members = yield* Effect.forEach(composition.members, ({ id }) => stack.services.get(id));
  return databaseFor(members);
});

type ReadyStack = { readonly stack: Stack; readonly database: DatabaseInstance };

/** The primary database and its status; none for the status when its owner is not reachable. */
const observeDatabase = Effect.fn("StackLocalDatabase.observe")(function* (stack: Stack) {
  const database = yield* databaseFromStack(stack);
  if (database === undefined) return undefined;
  const observation = yield* database.status.pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      (cause) => cause.reason === "owner-unavailable",
      () => Effect.succeed(Option.none()),
    ),
  );
  return { database, observation };
});

const databaseReady = Effect.fn("StackLocalDatabase.ready")(function* (stack: Stack) {
  const observed = yield* observeDatabase(stack);
  if (
    observed === undefined ||
    Option.isNone(observed.observation) ||
    observed.observation.value.lifecycle !== "running" ||
    observed.observation.value.health !== "healthy"
  )
    return Option.none<ReadyStack>();
  return Option.some({ stack, database: observed.database });
});

/** Whether the stack's primary database is absent, stopped, or has no reachable owner. */
const databaseStopped = Effect.fn("StackLocalDatabase.stopped")(function* (stack: Stack) {
  const observed = yield* observeDatabase(stack);
  return (
    observed === undefined ||
    Option.isNone(observed.observation) ||
    observed.observation.value.lifecycle === "stopped"
  );
});

/** Opens the registered project stack without starting its owner; a selected one must not be stopped. */
export const stackOpenProjectBy = <E>(
  onFailure: (cause: { readonly message: string; readonly suggestion?: string }) => E,
) =>
  Effect.gen(function* () {
    const { named, stack } = yield* openProjectStack();
    if (named !== undefined && Option.isSome(stack) && (yield* databaseStopped(stack.value)))
      return yield* selectedNotRunning(named, "is not running");
    return stack;
  }).pipe(Effect.mapError(onFailure));

/** The project stack when its primary database is healthy; a selected stack that is not fails instead. */
export const stackOpenReadyProject = Effect.gen(function* () {
  const { named, stack } = yield* openProjectStack().pipe(Effect.mapError(unavailable));
  const ready = Option.isNone(stack)
    ? Option.none<ReadyStack>()
    : yield* databaseReady(stack.value);
  if (Option.isNone(ready) && named !== undefined)
    return yield* selectedNotRunning(named, "is not running");
  return ready;
});

/** Fails when `--stack`/`--stack-id` or `SUPABASE_STACK`/`SUPABASE_STACK_ID` select a stack that does not exist. */
export const stackRequireSelected = Effect.gen(function* () {
  const selected = yield* selectedStack;
  if (describeStackSelector(selected) === undefined) return;
  yield* stackForProject();
}).pipe(Effect.mapError(unavailable));

/** The saved project stack's runtime as a hint; an absent or unreadable stack yields none. */
export const stackProjectRuntime = stackForProject().pipe(
  Effect.map(({ saved }) => saved?.runtime),
  Effect.orElseSucceed(() => undefined),
);

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
  StackRuntime,
  StackRuntimeUnavailableError,
  ProjectStackServices
> = stackProjectRuntime.pipe(
  Effect.flatMap((runtime) =>
    runtime === undefined ? Effect.fail(RUNTIME_UNAVAILABLE) : Effect.succeed(runtime),
  ),
);

/** Reads the database artifact pin from the saved database definition. */
export const stackProjectDatabasePin: Effect.Effect<
  ArtifactPin | undefined,
  never,
  ProjectStackServices
> = Effect.gen(function* () {
  const opened = yield* openProjectStack().pipe(
    Effect.map(({ stack }) => stack),
    Effect.orElseSucceed(() => Option.none<Stack>()),
  );
  if (Option.isNone(opened)) return undefined;
  const database = yield* databaseFromStack(opened.value).pipe(
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );
  if (database === undefined) return undefined;
  const status = yield* database.status.pipe(Effect.option, Effect.map(Option.getOrUndefined));
  return status?.config.service === "database" ? status.config.pin : undefined;
}).pipe(Effect.scoped);

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

const stackLocalDatabaseUrl: Effect.Effect<string, LocalDbRunningError, ProjectStackServices> =
  Effect.gen(function* () {
    const opened = yield* stackOpenReadyProject.pipe(Effect.mapError(unavailable));
    if (Option.isNone(opened)) return yield* notRunning();
    const status = yield* opened.value.database.status.pipe(Effect.mapError(unavailable));
    const endpoint = status.endpoints.find(({ name }) => name === "sql");
    if (status.config.service !== "database")
      return yield* notRunning("The local stack primary service is not a database.");
    if (endpoint === undefined)
      return yield* notRunning("The local stack database SQL endpoint is unavailable.");
    return toUserFacingDatabaseUrl({
      host: endpoint.host,
      port: endpoint.port,
      password: Redacted.value(status.config.config.databasePassword),
    });
  }).pipe(Effect.scoped);

export const stackLocalDatabaseConn: Effect.Effect<
  PgConnInput,
  LocalDbRunningError,
  ProjectStackServices
> = stackLocalDatabaseUrl.pipe(
  Effect.flatMap((url) => parseConnectionString(url)),
  Effect.flatMap((conn) =>
    conn === undefined
      ? Effect.fail(notRunning("failed to parse stack database URL"))
      : Effect.succeed(conn),
  ),
  Effect.mapError(unavailable),
);

/**
 * Starts or resumes the primary database, initializing the catalog on first creation. A selected
 * stack that does not exist yet is created only with `createSelected` (`db start`).
 */
export const stackEnsurePostgresOnlyStarted = Effect.fn(
  "StackLocalDatabase.ensurePostgresOnlyStarted",
)(function* (options: { readonly createSelected?: boolean } = {}) {
  const api = yield* StackApi;
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  /* Checked before the config load, which can resolve and write supabase/supabase.lock. */
  const {
    selected,
    named,
    saved: existing,
  } = yield* stackForProject(options).pipe(
    Effect.mapError((cause) =>
      cause instanceof StackTargetError && cause.reason !== "flags"
        ? startFailed(cause)
        : unavailable(cause),
    ),
  );
  const config = yield* loadStackConfig(settings.workdir, {
    selection: lockedSelection({ frozen: false, output }),
  }).pipe(Effect.mapError(startFailed));
  const toml = yield* readDbConfig(fs, path, settings.workdir).pipe(Effect.mapError(startFailed));
  const experimental = yield* resolveExperimentalWithProjectEnv({ ...toml.projectEnv });
  const keys =
    existing === undefined ? yield* config.keys.pipe(Effect.mapError(startFailed)) : undefined;
  const createStack = Effect.gen(function* () {
    const runtime = yield* selectStackRuntime(undefined).pipe(
      Effect.mapError(
        (error) =>
          new LocalDbRunningError({
            message: `failed to start local database: ${error.message}`,
            daemonDown: true,
            suggestion: error.suggestion,
          }),
      ),
    );
    const created = yield* api
      .create({
        projectRoot: settings.workdir,
        ...(selected.name === undefined ? {} : { name: selected.name }),
        stateRoot: stateRoot(settings, path),
        cacheRoot: cacheRoot(settings, path),
        runtime,
      })
      .pipe(Effect.mapError(startFailed));
    const notice = automaticRuntimeNotice(
      undefined,
      runtime,
      named === undefined ? "" : ` ${named.flags}`,
    );
    if (notice !== undefined) yield* output.info(notice);
    return created;
  });
  const stack =
    existing === undefined
      ? yield* createStack
      : yield* api
          .open({
            id: existing.id,
            stateRoot: stateRoot(settings, path),
            cacheRoot: cacheRoot(settings, path),
          })
          .pipe(Effect.mapError(startFailed));
  const creations = yield* config.creations(stack.id).pipe(Effect.mapError(startFailed));
  const databaseCreation = creations.find(
    (creation): creation is Extract<ServiceCreationInput, { service: "database" }> =>
      creation.service === "database",
  );
  if (databaseCreation === undefined)
    return yield* startFailed({ message: "database is disabled in the local configuration" });
  const currentDatabase = yield* databaseFromStack(stack).pipe(Effect.mapError(startFailed));
  if (currentDatabase !== undefined) {
    const planned = yield* stack.composition
      .plan([databaseCreation])
      .pipe(Effect.mapError(startFailed));
    if (
      planned.some(
        (entry) =>
          entry.id === currentDatabase.id &&
          entry.change === "incompatible" &&
          entry.paths.includes("pin"),
      )
    )
      return yield* startFailed({
        message: `The requested database version does not match the saved stack binding. Recreate the local database: supabase stack destroy --stack-id ${stack.id}`,
      });
    const savedCredentials = yield* stack.credentials.get.pipe(Effect.mapError(startFailed));
    if (
      savedCredentials !== undefined &&
      ((databaseCreation.config.jwtSecret !== undefined &&
        Redacted.value(databaseCreation.config.jwtSecret) !== savedCredentials.jwtSecret) ||
        (databaseCreation.config.rootKey !== undefined &&
          Redacted.value(databaseCreation.config.rootKey) !== savedCredentials.postgresRootKey))
    )
      return yield* startFailed({
        message: "The configured credentials conflict with the saved stack credentials",
      });
    if (Option.isSome(yield* databaseReady(stack).pipe(Effect.mapError(startFailed)))) {
      yield* applyStackWebhooksOnly(currentDatabase, toml.webhooksEnabled).pipe(
        Effect.mapError(startFailed),
      );
      return "already-running" as const;
    }
    const pinChanged = planned.some(
      (entry) =>
        entry.id === currentDatabase.id &&
        entry.change === "changed" &&
        entry.paths.includes("pin"),
    );
    // A stopped database starts the selected pin; the instance id and its data stay.
    const database = pinChanged
      ? databaseFor(
          yield* stack.composition
            .supabase([databaseCreation], {
              reuseIds: [currentDatabase.id],
              retainMembers: true,
            })
            .pipe(Effect.mapError(startFailed)),
        )
      : currentDatabase;
    if (database === undefined)
      return yield* startFailed({ message: "stack did not rebind the database instance" });
    yield* database.start.pipe(Effect.mapError(startFailed));
    yield* database.ready.pipe(Effect.mapError(startFailed));
    yield* applyStackWebhooksOnly(database, toml.webhooksEnabled).pipe(
      Effect.mapError(startFailed),
    );
    return "started" as const;
  }
  const existingDatabase = yield* stack.services.list.pipe(Effect.mapError(startFailed));
  if (databaseFor(existingDatabase) !== undefined)
    return yield* startFailed({
      message:
        "A standalone database exists outside the saved stack composition. Destroy the standalone database before starting this stack.",
    });
  const effectiveKeys = keys ?? (yield* config.keys.pipe(Effect.mapError(startFailed)));
  const [database] = yield* stack.composition
    .supabase([databaseCreation], { keys: effectiveKeys })
    .pipe(Effect.mapError(startFailed));
  if (database === undefined || database.service !== "database")
    return yield* startFailed({ message: "stack did not create a database instance" });
  return yield* Effect.gen(function* () {
    yield* database.start.pipe(Effect.mapError(startFailed));
    yield* database.ready.pipe(Effect.mapError(startFailed));
    const credentials = yield* stack.credentials.get.pipe(Effect.mapError(startFailed));
    if (credentials === undefined)
      return yield* startFailed({ message: "stack credentials were not saved" });
    yield* initializeStackDatabase({
      target: {
        stack,
        database,
        databaseServices: catalogDatabaseServices(creations),
        selection: config.selection,
      },
      overlay: projectCatalogOverlay(toml, settings.workdir),
      migrations: { workdir: settings.workdir, toml, experimental },
    }).pipe(Effect.mapError(startFailed));
    return "started" as const;
  }).pipe(
    Effect.onError(() =>
      database.destroy.pipe(
        Effect.tapError((cause) =>
          output.raw(
            `Failed to destroy newly created database ${database.id}: ${cause.message}. Run supabase stack destroy --stack-id ${stack.id} to remove the incomplete stack before retrying.\n`,
            "stderr",
          ),
        ),
        Effect.ignore,
      ),
    ),
  );
});
