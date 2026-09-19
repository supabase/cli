import { defaultStackRuntime } from "../../../../command-internal/stack-runtime.ts";
import { Effect, Equal, FileSystem, Fiber, Option, Path, Redacted, Ref } from "effect";
import type { ServiceCreation, Stack } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  OutputFlag,
  resolveExperimentalWithProjectEnv,
} from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { readDbToml } from "../../../../command-internal/db-config.toml-read.ts";
import { StackCatalogSetup } from "../../../../command-internal/stack-catalog-setup.ts";
import {
  applyStackMigrateAndSeed,
  applyStackWebhooksOnly,
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

const stackError = (cause: { readonly message: string }) =>
  new StackCommandStartError({
    reason: "unknown",
    message: cause.message,
    cause,
  });

const sameKinds = (
  left: ReadonlyArray<{ readonly service: string }>,
  right: ReadonlyArray<{ readonly service: string }>,
): boolean => {
  const leftKinds = new Set(left.map(({ service }) => service));
  const rightKinds = new Set(right.map(({ service }) => service));
  return leftKinds.size === rightKinds.size && [...leftKinds].every((kind) => rightKinds.has(kind));
};

const sameBinding = (
  observed: {
    readonly service: string;
    readonly version?: string;
    readonly config: unknown;
    readonly endpoints?: unknown;
  },
  requested: {
    readonly service: string;
    readonly version?: string;
    readonly config: unknown;
    readonly endpoints?: unknown;
  },
): boolean =>
  observed.service === requested.service &&
  observed.version === requested.version &&
  Equal.equals(observed.endpoints, requested.endpoints) &&
  Equal.equals(
    comparableConfig(observed.service, observed.config),
    comparableConfig(requested.service, requested.config),
  );

const factoryBoundConfigKeys: Readonly<Record<string, ReadonlySet<string>>> = {
  database: new Set(["databasePassword", "jwtSecret"]),
  rest: new Set(["databaseUrl", "jwtSecret"]),
  auth: new Set(["databaseUrl", "jwtSecret", "externalApiUrl", "smtpUrl"]),
  realtime: new Set(["databaseUrl", "jwtSecret"]),
  storage: new Set(["databaseUrl", "filePath", "jwtSecret", "imgproxyUrl"]),
  functions: new Set(["functionsRoot", "bootstrap", "apiUrl", "jwtSecret"]),
  studio: new Set([
    "functionsRoot",
    "pgmetaUrl",
    "analyticsUrl",
    "functionsUrl",
    "apiUrl",
    "publicApiUrl",
    "jwtSecret",
  ]),
  analytics: new Set(["databaseUrl"]),
  vector: new Set(["analyticsUrl"]),
  pgmeta: new Set(["databaseUrl"]),
  pooler: new Set(["databaseUrl", "jwtSecret"]),
};

const comparableConfig = (service: string, value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const ignored = factoryBoundConfigKeys[service] ?? new Set<string>();
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key)));
};

const selectedCreations = (
  creations: ReadonlyArray<ServiceCreation>,
  exclusions: ReadonlyArray<string>,
) =>
  creations.filter((creation) => {
    const capability = stackCapabilityForService(creation.service);
    return !exclusions.includes(capability);
  });

const compose = (
  stack: Stack,
  creations: ReadonlyArray<ServiceCreation>,
  reuseIds: ReadonlyArray<string>,
) => stack.composition.supabase(creations, reuseIds.length === 0 ? undefined : { reuseIds });

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
    const config = yield* loadStackConfig(target.projectRoot).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandStartError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    const toml = yield* readDbToml(fs, path, target.projectRoot).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandStartError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    const stateRoot = path.join(settings.supabaseHome, "stacks");
    const cacheRoot = path.join(settings.supabaseHome, "cache", "stack");
    const stack =
      target.id === undefined
        ? yield* stackApi
            .create({
              projectRoot: target.projectRoot,
              stateRoot,
              cacheRoot,
              runtime: target.runtime ?? defaultStackRuntime(runtime),
              ...(target.name === undefined ? {} : { name: target.name }),
            })
            .pipe(Effect.mapError(stackError))
        : yield* stackApi
            .open({ id: target.id, stateRoot, cacheRoot })
            .pipe(Effect.mapError(stackError));
    const existingServices = yield* stack.services.list.pipe(Effect.mapError(stackError));
    const composition = yield* stack.composition.describe.pipe(Effect.mapError(stackError));
    const currentInstances = yield* Effect.forEach(composition.members, ({ id }) =>
      stack.services.get(id).pipe(Effect.mapError(stackError)),
    );
    const primaryDatabase = currentInstances.find((instance) => instance.service === "database");
    const shadowDatabase =
      composition.members.length === 0
        ? existingServices.find((instance) => instance.service === "database")
        : undefined;
    if (shadowDatabase !== undefined)
      return yield* new StackCommandStartError({
        reason: "lifecycle",
        message: "A standalone database exists outside the saved stack composition",
        suggestion: "Stop or destroy the standalone database before starting this stack.",
      });
    const persistedJwt =
      primaryDatabase === undefined
        ? undefined
        : yield* primaryDatabase.status.pipe(
            Effect.catchTag("StackError", () =>
              primaryDatabase
                .credentials({ from: "host" })
                .pipe(Effect.andThen(primaryDatabase.status)),
            ),
            Effect.map((status) =>
              status.config.service === "database"
                ? Redacted.isRedacted(status.config.config.jwtSecret)
                  ? status.config.config.jwtSecret
                  : Redacted.make(status.config.config.jwtSecret)
                : undefined,
            ),
            Effect.mapError(stackError),
          );
    if (primaryDatabase !== undefined && persistedJwt === undefined)
      return yield* new StackCommandStartError({
        reason: "invalid-config",
        message: "The existing database has no persisted JWT secret",
      });
    const creations = yield* config
      .creations(stack.id, persistedJwt === undefined ? undefined : { jwtSecret: persistedJwt })
      .pipe(
        Effect.mapError(
          (error) =>
            new StackCommandStartError({
              reason: "invalid-config",
              message: error.message,
              cause: error,
            }),
        ),
      );
    const requested = selectedCreations(creations, exclusions);
    if (
      requested.some(({ service }) => service === "studio") &&
      !requested.some(({ service }) => service === "rest")
    )
      return yield* new StackCommandStartError({
        reason: "flags",
        message: "Studio cannot be started without the REST API capability",
        suggestion: "Remove --exclude rest or also exclude studio.",
      });
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
    let compositionChanged = !sameKinds(currentInstances, requested);
    for (const instance of currentInstances) {
      const creation = requested.find(({ service }) => service === instance.service);
      if (creation === undefined) continue;
      const status = yield* instance.status.pipe(Effect.mapError(stackError));
      if (!sameBinding(status.config, creation))
        return yield* new StackCommandStartError({
          reason: "invalid-config",
          message: `The requested ${creation.service} configuration does not match the saved stack binding`,
          suggestion:
            "Keep the saved endpoint and version settings, or destroy the stack before changing them.",
        });
    }
    const reuseIds: Array<string> = compositionChanged
      ? currentInstances
          .filter((instance) => requested.some((creation) => creation.service === instance.service))
          .map(({ id }) => id)
      : [];
    if (compositionChanged) {
      const currentKinds = new Set(currentInstances.map(({ service }) => service));
      for (const creation of requested) {
        if (currentKinds.has(creation.service)) continue;
        const candidates = [];
        for (const candidate of existingServices) {
          if (candidate.service !== creation.service || reuseIds.includes(candidate.id)) continue;
          const status = yield* candidate.status.pipe(
            Effect.map(Option.some),
            Effect.catchTag("StackError", () => Effect.succeed(Option.none())),
          );
          if (
            Option.isSome(status) &&
            status.value.lifecycle === "stopped" &&
            !status.value.wakeEnabled &&
            sameBinding(status.value.config, creation)
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
    }
    const starting = yield* output.task("Starting local Supabase stack...");
    if (compositionChanged && composition.members.length > 0) {
      const stopping = yield* output.task(
        "Stopping local Supabase stack before applying changes...",
      );
      yield* stack.composition.stop.pipe(
        Effect.tapError((error) => stopping.fail(error.message)),
        Effect.mapError(stackError),
      );
      yield* stopping.succeed();
    } else if (compositionChanged && primaryDatabase !== undefined) {
      const stopping = yield* output.task(
        "Stopping local Supabase stack before applying changes...",
      );
      yield* primaryDatabase.stop.pipe(
        Effect.tapError((error) => stopping.fail(error.message)),
        Effect.mapError(stackError),
      );
      yield* stopping.succeed();
    }
    const members = compositionChanged
      ? yield* compose(stack, requested, reuseIds).pipe(
          Effect.tapError((error) => starting.fail(error.message)),
          Effect.mapError(stackError),
        )
      : currentInstances;
    const initialCleanupComplete = yield* Ref.make(!initialComposition);
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
        Ref.get(initialCleanupComplete).pipe(
          Effect.flatMap((complete) => (complete ? Effect.void : cleanupInitialSafe)),
        ),
      );
    }
    const configured = yield* stack.composition.describe.pipe(Effect.mapError(stackError));
    const desiredMembers = configured.members.map(({ id }) => {
      const member = members.find((entry) => entry.id === id);
      const eager = flags.eager || member?.service === "database";
      return {
        id,
        activation: eager ? ("eager" as const) : ("lazy" as const),
        ...(eager || member?.service === "functions" ? {} : { idleMillis: 60_000 }),
      };
    });
    const activationChanged = desiredMembers.some((desired) => {
      const current = configured.members.find(({ id }) => id === desired.id);
      return (
        current?.activation !== desired.activation || current?.idleMillis !== desired.idleMillis
      );
    });
    if (activationChanged) {
      if (!compositionChanged && composition.members.length > 0) {
        const stopping = yield* output.task(
          "Stopping local Supabase stack before applying changes...",
        );
        yield* stack.composition.stop.pipe(
          Effect.tapError((error) => stopping.fail(error.message)),
          Effect.mapError(stackError),
        );
        yield* stopping.succeed();
      }
      yield* stack.composition
        .configure({ ...configured, members: desiredMembers })
        .pipe(Effect.mapError(stackError));
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
    const databaseServices = requested
      .filter(
        (creation) =>
          creation.service === "auth" ||
          creation.service === "storage" ||
          creation.service === "realtime",
      )
      .map((creation) => creation.service);
    const catalog = yield* Effect.service(StackCatalogSetup);
    if (initialComposition) {
      yield* catalog
        .apply({
          target: {
            stack,
            database,
            databaseServices,
            jwtSecret: Redacted.value(persistedJwt ?? config.jwtSecret),
          },
          overlay: {
            webhooks: "config",
            webhooksEnabled: toml.webhooksEnabled,
            apiAutoExposeNewTables: toml.baseline.apiAutoExposeNewTables,
            vault: toml.vault,
            workdir: target.projectRoot,
          },
        })
        .pipe(
          Effect.tapError((error) => starting.fail(error.message)),
          Effect.mapError(stackError),
        );
      const experimental = yield* resolveExperimentalWithProjectEnv({ ...toml.projectEnv });
      yield* applyStackMigrateAndSeed(database, target.projectRoot, toml, experimental).pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
    } else if (compositionChanged) {
      yield* catalog
        .apply({
          target: {
            stack,
            database,
            databaseServices,
            jwtSecret: Redacted.value(persistedJwt ?? config.jwtSecret),
          },
          overlay: {
            webhooks: "config",
            webhooksEnabled: toml.webhooksEnabled,
            apiAutoExposeNewTables: toml.baseline.apiAutoExposeNewTables,
            vault: toml.vault,
            workdir: target.projectRoot,
          },
        })
        .pipe(
          Effect.tapError((error) => starting.fail(error.message)),
          Effect.mapError(stackError),
        );
      yield* applyStackWebhooksOnly(database, toml.webhooksEnabled).pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
    } else {
      yield* applyStackWebhooksOnly(database, toml.webhooksEnabled).pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError(stackError),
      );
    }
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
            Redacted.value(persistedJwt ?? config.jwtSecret),
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
      Effect.mapError(stackError),
    );
    yield* Effect.forEach(preparation, (fiber) => Fiber.join(fiber));
    yield* Ref.set(initialCleanupComplete, true);
    yield* starting.succeed("Stack is ready.");
    yield* output.success("", { id: stack.id });
    return stack.id;
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
