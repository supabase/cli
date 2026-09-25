import { endpointReports } from "../stack-endpoints.format.ts";
import { withProjectFunctionsEnv } from "../../../../command-internal/stack-functions-env.ts";
import { defaultStackRuntime } from "../../../../command-internal/stack-runtime.ts";
import { Effect, FileSystem, Fiber, Option, Path, Redacted, Ref } from "effect";
import {
  resolveNativePostgresUser,
  type Observation,
  type PlannedInstance,
  type ServiceCreationInput,
  type StackError,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  OutputFlag,
  resolveExperimentalWithProjectEnv,
} from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { readDbToml } from "../../../../command-internal/db-config.toml-read.ts";
import { catalogDatabaseServices } from "../../../../command-internal/stack-catalog-setup.ts";
import {
  applyStackWebhooksOnly,
  initializeStackDatabase,
  projectCatalogOverlay,
} from "../../../../command-internal/stack-bootstrap.ts";
import { stackStorageCredentialsFor } from "../../../../command-internal/stack-storage.ts";
import {
  hasConfiguredBuckets,
  SeedConfigLoadError,
  seedBucketsRun,
} from "../../../../command-internal/seed-buckets.ts";
import { loadLocalProjectContext } from "../../../../command-internal/local-project-context.ts";
import { loadStackConfig } from "../../../../command-internal/stack-config.ts";
import {
  StackApi,
  stackCapabilityForService,
  StackTargetError,
  StackTargetResolver,
  failedOutcomesDetail,
  rejectStackOutput,
  validateStackTarget,
} from "../stack.shared.ts";
import type { StackStartFlags } from "./start.command.ts";
import { StackCommandStartError } from "./start.errors.ts";
import { STACK_START_EXCLUDABLE_CAPABILITIES } from "./start.options.ts";

const validateExclusions = (exclusions: ReadonlyArray<string>) => {
  const supported = new Set<string>(STACK_START_EXCLUDABLE_CAPABILITIES);
  const unknown = exclusions.filter((name) => name !== "database" && !supported.has(name));
  if (unknown.length > 0)
    return Effect.fail(
      new StackCommandStartError({
        reason: "flags",
        message: `Unknown stack capabilities in --exclude: ${unknown.map((name) => JSON.stringify(name)).join(", ")}`,
        suggestion: `Choose from ${STACK_START_EXCLUDABLE_CAPABILITIES.join(", ")}.`,
      }),
    );
  if (exclusions.includes("database"))
    return Effect.fail(
      new StackCommandStartError({
        reason: "flags",
        message: "The database capability cannot be excluded from a stack.",
        suggestion: "Remove database from --exclude.",
      }),
    );
  return Effect.succeed(
    STACK_START_EXCLUDABLE_CAPABILITIES.filter((name) => exclusions.includes(name)),
  );
};

const mapTargetError = (error: StackTargetError) =>
  new StackCommandStartError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

const stackError = (
  cause: { readonly message: string } & Partial<Pick<StackError, "outcomes">>,
  members: ReadonlyArray<{ readonly id: string; readonly service: string }> = [],
) => {
  const detail = failedOutcomesDetail(cause, (id) => {
    const service = members.find((member) => member.id === id)?.service;
    return service === undefined ? id : `${service} (${id})`;
  });
  return new StackCommandStartError({
    reason: "unknown",
    message: cause.message,
    ...(detail === undefined ? {} : { detail }),
    cause,
  });
};

const loadStartConfig = (projectRoot: string, fs: FileSystem.FileSystem, path: Path.Path) =>
  Effect.gen(function* () {
    const config = yield* loadStackConfig(projectRoot);
    const keys = yield* config.keys;
    const toml = yield* readDbToml(fs, path, projectRoot);
    return { config, keys, toml };
  }).pipe(
    Effect.mapError(
      (error) =>
        new StackCommandStartError({
          reason: "invalid-config",
          message: error.message,
          cause: error,
        }),
    ),
  );

const sameKinds = (
  left: ReadonlyArray<{ readonly service: string }>,
  right: ReadonlyArray<{ readonly service: string }>,
): boolean => {
  const leftKinds = new Set(left.map(({ service }) => service));
  const rightKinds = new Set(right.map(({ service }) => service));
  return leftKinds.size === rightKinds.size && [...leftKinds].every((kind) => rightKinds.has(kind));
};

/** Rejects a saved instance whose endpoints or artifact versions the request would change. */
const incompatibleChange = (planned: PlannedInstance) =>
  planned.change !== "incompatible"
    ? undefined
    : planned.service === "database" && planned.paths.includes("config.version")
      ? new StackCommandStartError({
          reason: "invalid-config",
          message: "The requested database version does not match the saved stack binding",
          suggestion:
            "Keep the saved database version, or run supabase stack destroy to recreate the stack.",
        })
      : new StackCommandStartError({
          reason: "invalid-config",
          message: `The requested ${planned.service} ${planned.paths.join(", ")} cannot change on the saved stack`,
          suggestion:
            "Keep the saved endpoint and version settings, or run supabase stack destroy to recreate the stack.",
        });

const selectedCreations = (
  creations: ReadonlyArray<ServiceCreationInput>,
  exclusions: ReadonlyArray<string>,
) =>
  creations.filter((creation) => {
    const capability = stackCapabilityForService(creation.service);
    return !exclusions.includes(capability);
  });

const isServing = (status: Pick<Observation, "lifecycle" | "health">) =>
  status.lifecycle === "running" && status.health === "healthy";

const reportEndpoints = (
  members: ReadonlyArray<{
    readonly service: string;
    readonly status: Effect.Effect<Observation, StackError>;
  }>,
) =>
  Effect.forEach(members, (member) =>
    member.status.pipe(
      Effect.mapError(stackError),
      Effect.map((observation) =>
        Object.entries(endpointReports(observation)).map(
          ([name, endpoint]) => [`${member.service}.${name}`, endpoint] as const,
        ),
      ),
    ),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries.flat())));

/** Starts the selected managed stack and applies the local database overlays. */
export const stackStart = Effect.fn("experimental.stack.start")(function* (flags: StackStartFlags) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const runtime = yield* RuntimeInfo;
    const resolver = yield* StackTargetResolver;
    const stackApi = yield* StackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* rejectStackOutput(outputFlag).pipe(Effect.mapError(mapTargetError));
    const exclusions = yield* validateExclusions(flags.exclude);
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(Effect.mapError(mapTargetError));
    const target = yield* resolver
      .resolve({
        projectRoot: settings.workdir,
        ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
        ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
        runtime: flags.runtime,
      })
      .pipe(Effect.mapError(mapTargetError));
    const selectedRuntime = target.runtime ?? defaultStackRuntime(runtime);
    const postgresUser = yield* resolveNativePostgresUser(selectedRuntime);
    const ensurePostgresUser =
      postgresUser._tag === "Unavailable"
        ? new StackCommandStartError({
            reason: "lifecycle",
            message: postgresUser.message,
            suggestion: postgresUser.suggestion,
          })
        : postgresUser._tag === "StepDown"
          ? output.info(postgresUser.message)
          : Effect.void;
    const configBeforeCreate =
      target.id === undefined ? yield* loadStartConfig(target.projectRoot, fs, path) : undefined;
    if (target.id === undefined) yield* ensurePostgresUser;
    const stateRoot = path.join(settings.supabaseHome, "stacks");
    const cacheRoot = path.join(settings.supabaseHome, "cache", "stack");
    const startupComplete = yield* Ref.make(false);
    const stack = yield* Effect.acquireRelease(
      target.id === undefined
        ? stackApi.create({
            projectRoot: target.projectRoot,
            stateRoot,
            cacheRoot,
            runtime: selectedRuntime,
            startOwner: true,
            ...(target.name === undefined ? {} : { name: target.name }),
          })
        : stackApi.open({ id: target.id, stateRoot, cacheRoot, startOwner: true }),
      (stack) =>
        Ref.get(startupComplete).pipe(
          Effect.flatMap((complete) =>
            complete || target.hostRunning
              ? Effect.void
              : stack.stop.pipe(
                  Effect.catch((error) =>
                    output.raw(
                      `Failed to stop stack host ${stack.id}: ${error.message}. Run supabase stack stop --stack-id ${stack.id} to stop it.\n`,
                      "stderr",
                    ),
                  ),
                ),
          ),
        ),
    ).pipe(Effect.mapError(stackError));
    const existingServices = yield* stack.services.list.pipe(Effect.mapError(stackError));
    const composition = yield* stack.composition.describe.pipe(Effect.mapError(stackError));
    const currentInstances = yield* Effect.forEach(composition.members, ({ id }) =>
      stack.services.get(id).pipe(Effect.mapError(stackError)),
    );
    const currentStatuses = yield* Effect.forEach(currentInstances, (instance) =>
      instance.status.pipe(Effect.mapError(stackError)),
    );
    const primaryDatabase = currentInstances.find((instance) => instance.service === "database");
    const databaseStatus = currentStatuses.find(({ id }) => id === primaryDatabase?.id);
    const fullyStarted =
      databaseStatus !== undefined &&
      isServing(databaseStatus) &&
      currentStatuses.every((status) =>
        status.lifecycle === "running" ? isServing(status) : status.wakeEnabled,
      );
    if (fullyStarted) {
      yield* Ref.set(startupComplete, true);
      yield* output.success(
        "Stack is already running with its current services. Run `supabase stack stop`, then `supabase stack start` to apply configuration or service-selection changes.",
        { id: stack.id, endpoints: yield* reportEndpoints(currentInstances) },
      );
      return stack.id;
    }
    const resumable =
      primaryDatabase !== undefined &&
      databaseStatus?.lifecycle === "running" &&
      currentStatuses.every(
        ({ lifecycle, wakeEnabled }) =>
          lifecycle === "running" || lifecycle === "starting" || wakeEnabled,
      );
    if (resumable) {
      yield* output.info(
        "Resuming the saved stack services. Run `supabase stack stop`, then `supabase stack start` to apply configuration or service-selection changes.",
      );
      const starting = yield* output.task("Starting local Supabase stack...");
      yield* primaryDatabase.ready.pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
      yield* stack.composition.start.pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError((error) => stackError(error, currentInstances)),
      );
      yield* Ref.set(startupComplete, true);
      const endpoints = yield* reportEndpoints(currentInstances).pipe(
        Effect.tapError((error) => starting.fail(error.message)),
      );
      yield* starting.succeed("Stack is ready.");
      yield* output.success("", { id: stack.id, endpoints });
      return stack.id;
    }
    const fullyStopped = currentStatuses.every(
      ({ lifecycle, wakeEnabled }) => lifecycle === "stopped" && !wakeEnabled,
    );
    if (!fullyStopped)
      return yield* new StackCommandStartError({
        reason: "lifecycle",
        message: "The stack is in a partial lifecycle state",
        suggestion: "Run supabase stack stop, then supabase stack start to recover the stack.",
      });
    if (target.id !== undefined) yield* ensurePostgresUser;
    const shadowDatabase =
      composition.members.length === 0
        ? existingServices.find((instance) => instance.service === "database")
        : undefined;
    if (shadowDatabase !== undefined)
      return yield* new StackCommandStartError({
        reason: "lifecycle",
        message: "A standalone database exists outside the saved stack composition",
        suggestion: "Destroy the standalone database before starting this stack.",
      });
    const { config, keys, toml } =
      configBeforeCreate ?? (yield* loadStartConfig(target.projectRoot, fs, path));
    const creations = yield* config.creations(stack.id).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandStartError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    const requested = yield* Effect.forEach(
      selectedCreations(creations, exclusions),
      withProjectFunctionsEnv,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new StackCommandStartError({ reason: "invalid-config", message: cause.message, cause }),
      ),
    );
    if (
      requested.some(({ service }) => service === "studio") &&
      !requested.some(({ service }) => service === "rest")
    )
      return yield* new StackCommandStartError({
        reason: "flags",
        message: "Studio cannot be started without the REST API capability",
        suggestion: "Remove --exclude rest or also exclude studio.",
      });
    const requestedDatabase = requested.find((creation) => creation.service === "database");
    const savedCredentials = yield* stack.credentials.get.pipe(Effect.mapError(stackError));
    if (requestedDatabase?.service === "database" && savedCredentials !== undefined) {
      const rootKey = requestedDatabase.config.rootKey;
      if (rootKey !== undefined && Redacted.value(rootKey) !== savedCredentials.postgresRootKey)
        return yield* new StackCommandStartError({
          reason: "invalid-config",
          message: "The configured Postgres root key conflicts with the saved stack credentials",
        });
    }
    if (requested.some(({ service }) => service === "storage"))
      yield* fs
        .makeDirectory(
          path.join(target.projectRoot, "supabase", ".temp", "stack-uploads", stack.id),
          {
            recursive: true,
          },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new StackCommandStartError({
                reason: "invalid-config",
                message: `Unable to create the Storage uploads directory: ${cause.message}`,
                cause,
              }),
          ),
        );
    if (requested.some(({ service }) => service === "functions"))
      yield* fs
        .makeDirectory(path.join(target.projectRoot, "supabase", "functions"), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new StackCommandStartError({
                reason: "invalid-config",
                message: `Unable to create the Functions directory: ${cause.message}`,
                cause,
              }),
          ),
        );
    const initialComposition = composition.members.length === 0;
    const serviceKindsChanged = !sameKinds(currentInstances, requested);
    const planned = yield* stack.composition.plan(requested).pipe(Effect.mapError(stackError));
    for (const entry of planned) {
      const rejected = entry.member ? incompatibleChange(entry) : undefined;
      if (rejected !== undefined) return yield* rejected;
    }
    const reuseIds: Array<string> = planned.filter(({ member }) => member).map(({ id }) => id);
    for (const creation of requested) {
      if (currentInstances.some(({ service }) => service === creation.service)) continue;
      const candidates = [];
      for (const candidate of planned) {
        if (
          candidate.member ||
          candidate.service !== creation.service ||
          candidate.change === "incompatible"
        )
          continue;
        const status = yield* stack.services.get(candidate.id).pipe(
          Effect.flatMap((instance) => instance.status),
          Effect.map(Option.some),
          Effect.catchTag("StackError", () => Effect.succeed(Option.none())),
        );
        if (
          Option.isSome(status) &&
          status.value.lifecycle === "stopped" &&
          !status.value.wakeEnabled
        )
          candidates.push(candidate);
      }
      if (candidates.length > 1)
        return yield* new StackCommandStartError({
          reason: "lifecycle",
          message: `Multiple stopped ${creation.service} instances match this stack configuration`,
          suggestion: "Remove the unused stack service, then retry.",
        });
      const candidate = candidates[0];
      if (candidate !== undefined) reuseIds.push(candidate.id);
    }
    const starting = yield* output.task("Starting local Supabase stack...");
    const members = yield* stack.composition
      .supabase(requested, {
        keys,
        eager: flags.eager,
        ...(reuseIds.length === 0 ? {} : { reuseIds }),
      })
      .pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
    if (initialComposition) {
      const existingIds = new Set(existingServices.map(({ id }) => id));
      const owned = members.filter(({ id }) => !existingIds.has(id));
      const cleanupInitialSafe = Effect.gen(function* () {
        yield* stack.composition.stop;
        yield* stack.composition.configure({ members: [], dependencies: [] });
        yield* Effect.forEach(
          owned,
          (instance) =>
            instance.destroy.pipe(
              Effect.catch((error) =>
                output.raw(
                  `Failed to remove initial ${instance.service} instance ${instance.id}: ${error.message}. Run supabase stack destroy --stack-id ${stack.id} before retrying.\n`,
                  "stderr",
                ),
              ),
            ),
          { discard: true },
        );
      }).pipe(
        Effect.catch((error) =>
          output.raw(
            `Failed to clean up initial stack ${stack.id}: ${error.message}. Run supabase stack destroy --stack-id ${stack.id} before retrying.\n`,
            "stderr",
          ),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Ref.get(startupComplete).pipe(
          Effect.flatMap((complete) => (complete ? Effect.void : cleanupInitialSafe)),
        ),
      );
    }
    const database = members.find((instance) => instance.service === "database");
    if (database === undefined)
      return yield* new StackCommandStartError({
        reason: "invalid-config",
        message: "The stack composition has no database service",
      });
    const preparation =
      flags.preparation === "background"
        ? yield* Effect.forEach(
            members,
            (member) => member.prepare.pipe(Effect.mapError(stackError), Effect.forkScoped),
            { concurrency: "unbounded" },
          )
        : [];
    yield* database.start.pipe(
      Effect.tapError((error) => starting.fail(error.message)),
      Effect.mapError(stackError),
    );
    yield* database.ready.pipe(
      Effect.tapError((error) => starting.fail(error.message)),
      Effect.mapError(stackError),
    );
    const stackCredentials = yield* stack.credentials.get.pipe(Effect.mapError(stackError));
    if (stackCredentials === undefined)
      return yield* new StackCommandStartError({
        reason: "invalid-config",
        message: "The stack has no saved credentials",
      });
    if (initialComposition || serviceKindsChanged) {
      const migrations = initialComposition
        ? {
            workdir: target.projectRoot,
            toml,
            experimental: yield* resolveExperimentalWithProjectEnv({ ...toml.projectEnv }),
          }
        : undefined;
      yield* initializeStackDatabase({
        target: { stack, database, databaseServices: catalogDatabaseServices(requested) },
        overlay: projectCatalogOverlay(toml, target.projectRoot),
        ...(migrations === undefined ? {} : { migrations }),
      }).pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
    }
    if (!initialComposition)
      yield* applyStackWebhooksOnly(database, toml.webhooksEnabled).pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
    if (initialComposition) {
      const storage = members.find((instance) => instance.service === "storage");
      if (storage !== undefined) {
        const context = yield* loadLocalProjectContext(
          target.projectRoot,
          (message) => new SeedConfigLoadError({ message }),
        );
        if (hasConfiguredBuckets(context.config)) {
          yield* storage.start.pipe(
            Effect.tapError((error) => starting.fail(error.message)),
            Effect.mapError(stackError),
          );
          yield* storage.ready.pipe(
            Effect.tapError((error) => starting.fail(error.message)),
            Effect.mapError(stackError),
          );
          const credentials = yield* stackStorageCredentialsFor(
            storage,
            stackCredentials.serviceRoleKey,
          ).pipe(Effect.mapError(stackError));
          yield* seedBucketsRun({
            projectRef: "",
            emitSummary: false,
            interactive: false,
            yes: true,
            credentials,
            resolvedConfig: { config: context.config, document: context.loaded?.document },
            projectEnvValues: toml.projectEnv,
            workdir: target.projectRoot,
          }).pipe(Effect.mapError(stackError));
        }
      }
    }
    yield* stack.composition.start.pipe(
      Effect.tapError((error) => starting.fail(error.message)),
      Effect.mapError((error) => stackError(error, members)),
    );
    yield* Effect.forEach(preparation, (fiber) => Fiber.join(fiber));
    yield* Ref.set(startupComplete, true);
    const endpoints = yield* reportEndpoints(members).pipe(
      Effect.tapError((error) => starting.fail(error.message)),
    );
    yield* starting.succeed("Stack is ready.");
    yield* output.success("", { id: stack.id, endpoints });
    return stack.id;
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
