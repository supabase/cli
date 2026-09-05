import {
  Cause,
  Config,
  Context,
  Crypto,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Path,
  Ref,
  Result,
  Scope,
  Schedule,
  Semaphore,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { eagerCapabilities, type PlannedWorkload } from "../model/ExecutionPlan.ts";
import { rebuildExecutionPlan, type StackDefinition } from "../model/Compiler.ts";
import {
  makeFunctionsBootstrapOwner,
  type FunctionsBootstrapOwner,
} from "../functions/FunctionsBootstrap.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { redactKnownSecrets } from "../state/SecretStore.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { PersistedSecretValues } from "../state/StackState.ts";
import type { StackId } from "../public/StackId.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { ArtifactPreparationStatus } from "../public/Status.ts";
import type { CapabilityName } from "../public/Capability.ts";
import {
  GatewayActivationError,
  StackPreparationError,
  ContainerEngineError,
  PortUnavailableError,
  StackRuntimeMismatchError,
  StackStateInvalidError,
  type StackError,
} from "../public/Errors.ts";
import { makeSupervisorIngress, type SupervisorIngress } from "../supervisor/Ingress.ts";
import { checkHostPort } from "../supervisor/HostListener.ts";
import {
  LogStoreError,
  makeLogStore,
  type LogStore,
  type LogRecord,
} from "../supervisor/LogStore.ts";
import type { LifecycleInput } from "../supervisor/Lifecycle.ts";
import type { SupervisorRuntime } from "../supervisor/Supervisor.ts";
import {
  makeProductionRuntimeArtifactPreparer,
  type RuntimeArtifactPreparationProgress,
  type RuntimeArtifactPreparationProgressListener,
  type PreparedWorkloadArtifact,
  type RuntimeArtifactPreparer,
} from "../preparation/RuntimeArtifacts.ts";
import { makeRuntimeEnvFileOwner, type RuntimeEnvFileOwner } from "./RuntimeEnvFile.ts";
import {
  makeRuntimeInputOwner,
  type RuntimeInputOwner,
  type RuntimeJsonFetcher,
} from "./RuntimeInputOwner.ts";
import type { NativeProcessSpec } from "./NativeProcess.ts";
import {
  resolveContainerResolutionFor,
  runtimeSpecFor,
  validatePrivateAssignments,
  validateWorkloadRuntimeInputs,
  type WorkloadRuntimeInputs,
} from "./WorkloadRuntimeSpec.ts";
import { makeNativeRuntime } from "./NativeRuntime.ts";
import { makeContainerRuntime, type ContainerWorkloadResolution } from "./ContainerRuntime.ts";
import { DEFAULT_READINESS_DEADLINE, probeReadiness } from "./ReadinessProbe.ts";
import { parseGoDuration } from "../model/capabilities/database.ts";
import type {
  ContainerEngine,
  ContainerEngineKind,
  ContainerHostRoute,
} from "./ContainerEngine.ts";
import { resolveContainerEngine } from "./ContainerEngineResolver.ts";
import { bootstrapDatabaseAt } from "./PostgresDatabaseSession.ts";
import { DatabaseBootstrapError } from "../model/DatabaseBootstrap.ts";
import { validateMaterializedSecrets } from "../state/MaterializedSettings.ts";
import {
  RuntimeDriverError,
  type RuntimeDriver,
  type RuntimeWorkloadKey,
} from "./RuntimeDriver.ts";

type RuntimeContext = FileSystem.FileSystem | Path.Path | Crypto.Crypto;

export interface ProductionRuntimeOptions {
  readonly stateRoot: string;
  readonly artifactCacheRoot?: string;
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly stateStore: StackStateStore;
  readonly context: Context.Context<RuntimeContext>;
  readonly artifactPreparer?: RuntimeArtifactPreparer;
  readonly containerEngine?: ContainerEngine;
  readonly ingress?: SupervisorIngress;
  readonly logStore?: LogStore;
  readonly envFileOwner?: RuntimeEnvFileOwner;
  readonly functionsBootstrapOwner?: FunctionsBootstrapOwner;
  readonly fetchJson?: RuntimeJsonFetcher;
  readonly bootstrapDatabase?: (
    state: PersistedStackState,
  ) => Effect.Effect<void, DatabaseBootstrapError | StackPreparationError>;
}

const preparationError = (message: string, cause?: unknown): StackPreparationError =>
  new StackPreparationError({ message, ...(cause === undefined ? {} : { cause }) });

const unavailableLogStore = (error: LogStoreError, path: string): LogStore => ({
  path,
  append: () => Effect.fail(error),
  read: () => Effect.fail(error),
});

const driverError = (
  key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">,
  message: string,
  cause?: unknown,
): RuntimeDriverError =>
  new RuntimeDriverError({
    message,
    stackId: key.stackId,
    workloadId: key.workloadId,
    ...(cause === undefined ? {} : { cause }),
  });

const stateSecrets = (state: PersistedStackState): ReadonlyArray<string> =>
  Object.values(state.secrets)
    .map((entry) => entry.value)
    .filter((value) => value.length > 0);

const currentStateReader = (options: ProductionRuntimeOptions) =>
  options.stateStore.read(options.stackId).pipe(
    Effect.provideContext(options.context),
    Effect.flatMap((state) =>
      state === undefined
        ? Effect.fail(
            new StackStateInvalidError({
              message: "Persisted stack state is missing",
              stackId: options.stackId,
            }),
          )
        : Effect.succeed(state),
    ),
  );

const artifactKey = (runtime: StackRuntime, workload: PlannedWorkload): string =>
  `${runtime.kind}:${runtime.kind === "container" ? runtime.engine : ""}:${workload.id}:${workload.selected.kind === "native" ? workload.selected.release : workload.selected.image}`;

const runtimeMatches = (left: StackRuntime, right: StackRuntime): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "native" || right.kind === "native") return true;
  return left.engine === right.engine;
};

const urlHost = (host: string): string => {
  const normalized = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
};

const DATABASE_WORKLOAD_ID = "database:database";
/** Atomic lifecycle witness for a successfully migrated native cluster. */
export const NATIVE_DATABASE_MIGRATION_MARKER = ".supabase-stack-migration-complete";
const checkNativeDatabaseLockEvidence = (
  fileSystem: FileSystem.FileSystem,
  lockPath: string,
): Effect.Effect<void, StackPreparationError> =>
  Effect.gen(function* () {
    if (
      !(yield* fileSystem
        .exists(lockPath)
        .pipe(
          Effect.mapError((error) =>
            preparationError("Unable to inspect native database lock evidence", error),
          ),
        ))
    )
      return;
    const firstLine = (yield* fileSystem
      .readFileString(lockPath)
      .pipe(
        Effect.mapError((error) =>
          preparationError("Unable to read native database lock evidence", error),
        ),
      ))
      .split("\n", 1)[0]
      ?.trim();
    if (firstLine === undefined || !/^[1-9]\d*$/u.test(firstLine))
      return yield* preparationError("Native database lock evidence contains an invalid PID");
    const pid = Number(firstLine);
    if (!Number.isSafeInteger(pid))
      return yield* preparationError("Native database lock evidence contains an invalid PID");
    const probe = yield* Effect.sync(
      (): { readonly alive: true } | { readonly alive: false; readonly cause: unknown } => {
        try {
          process.kill(pid, 0);
          return { alive: true };
        } catch (cause) {
          return { alive: false, cause };
        }
      },
    );
    const alive = probe.alive
      ? true
      : typeof probe.cause === "object" &&
          probe.cause !== null &&
          "code" in probe.cause &&
          probe.cause.code === "ESRCH"
        ? false
        : yield* preparationError("Unable to verify native database lock owner", probe.cause);
    if (alive)
      return yield* preparationError(
        `Native database lock is held by live process ${pid}; refusing a clean restart`,
      );
  });
const isDatabaseWorkload = (workload: PlannedWorkload): boolean =>
  workload.id === DATABASE_WORKLOAD_ID;
const configuredDatabaseReadinessDeadline = (
  definition: StackDefinition | undefined,
): Effect.Effect<Duration.Duration, StackPreparationError> => {
  if (definition === undefined)
    return Effect.fail(preparationError("Persisted database definition is missing"));
  const configured = definition.capabilities.database.settings.health_timeout;
  if (configured === undefined || configured === null)
    return Effect.fail(preparationError("Persisted database health_timeout is missing"));
  return Effect.try({
    try: () => parseGoDuration(configured),
    catch: (cause) => preparationError(`Invalid database health_timeout: ${configured}`, cause),
  }).pipe(
    Effect.flatMap((duration) =>
      Duration.isNegative(duration) || Duration.isZero(duration)
        ? Effect.fail(
            preparationError(
              `Invalid database health_timeout: ${configured}; duration must be positive`,
            ),
          )
        : Effect.succeed(duration),
    ),
  );
};

export const readinessDeadlineFor = (
  state: PersistedStackState,
  workload: PlannedWorkload,
): Effect.Effect<Duration.Duration, StackPreparationError> =>
  isDatabaseWorkload(workload)
    ? configuredDatabaseReadinessDeadline(state.definition)
    : Effect.succeed(DEFAULT_READINESS_DEADLINE);

const validateDatabaseReadinessBudget = (
  definition: StackDefinition,
  workloads: ReadonlyArray<PlannedWorkload>,
): Effect.Effect<void, StackPreparationError> =>
  workloads.some(isDatabaseWorkload)
    ? configuredDatabaseReadinessDeadline(definition).pipe(Effect.asVoid)
    : Effect.void;

const redactEntry = <A extends { readonly message: string }>(
  entry: A,
  secrets: ReadonlyArray<string>,
): A => {
  const message = redactKnownSecrets(entry.message, secrets);
  return message === entry.message ? entry : { ...entry, message };
};

/** Redacts against the monotonically growing set of secrets accepted by this owner. */
const dynamicLogStore = (base: LogStore, knownSecrets: Ref.Ref<ReadonlySet<string>>): LogStore => {
  const secrets = Ref.get(knownSecrets).pipe(Effect.map((values) => [...values]));
  return {
    path: base.path,
    append: (record: LogRecord) =>
      secrets.pipe(
        Effect.flatMap((known) =>
          base.append({ ...record, message: redactKnownSecrets(record.message, known) }),
        ),
      ),
    read: (options) =>
      secrets.pipe(
        Effect.flatMap((known) =>
          base
            .read(options)
            .pipe(Effect.map((entries) => entries.map((entry) => redactEntry(entry, known)))),
        ),
      ),
  };
};

const rememberSecrets = (
  knownSecrets: Ref.Ref<ReadonlySet<string>>,
  secrets: PersistedSecretValues,
): Effect.Effect<void> =>
  Ref.update(knownSecrets, (known) => {
    const next = new Set(known);
    for (const entry of Object.values(secrets)) {
      if (entry.value.length > 0) next.add(entry.value);
    }
    return next;
  });

const readinessFor = (
  state: PersistedStackState,
  workload: PlannedWorkload,
): Effect.Effect<void, StackPreparationError | RuntimeDriverError> => {
  const spec = runtimeSpecFor(workload);
  if (spec === undefined)
    return Effect.fail(preparationError(`Unknown runtime specification for ${workload.id}`));
  const endpoint = spec.privateEndpoint(state, spec.readiness.binding, "native");
  if (endpoint === undefined)
    return Effect.fail(preparationError(`Missing private readiness assignment for ${workload.id}`));
  return readinessDeadlineFor(state, workload).pipe(
    Effect.flatMap((deadline) =>
      probeReadiness(
        {
          mode: spec.readiness.protocol,
          host: "127.0.0.1",
          port: endpoint.port,
          ...(spec.readiness.path === undefined ? {} : { path: spec.readiness.path }),
          ...(spec.readiness.headers === undefined ? {} : { headers: spec.readiness.headers }),
        },
        { deadline },
      ),
    ),
  );
};

interface NativeDatabaseMigrationOptions {
  readonly key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">;
  readonly dataPath: string;
  readonly artifactRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly endpointPort: number;
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
}

/** Builds the one-shot native PostgreSQL migration process for an unmarked data directory. */
const prepareNativeDatabaseMigration = (
  options: NativeDatabaseMigrationOptions,
): Effect.Effect<NativeProcessSpec | undefined, RuntimeDriverError> =>
  Effect.gen(function* () {
    const { key, dataPath, artifactRoot, environment, endpointPort, fileSystem, pathService } =
      options;
    const markerPath = pathService.join(dataPath, NATIVE_DATABASE_MIGRATION_MARKER);
    const migrated = yield* fileSystem
      .exists(markerPath)
      .pipe(
        Effect.mapError((error) =>
          driverError(key, `Unable to inspect native database data path: ${error.message}`, error),
        ),
      );
    if (migrated) return undefined;
    const pgVersionPath = pathService.join(dataPath, "PG_VERSION");
    const initialized = yield* fileSystem
      .exists(pgVersionPath)
      .pipe(
        Effect.mapError((error) =>
          driverError(key, `Unable to inspect native database data path: ${error.message}`, error),
        ),
      );
    const postmasterOptionsPath = pathService.join(dataPath, "postmaster.opts");
    const completeInitialization = initialized
      ? yield* fileSystem
          .exists(postmasterOptionsPath)
          .pipe(
            Effect.mapError((error) =>
              driverError(
                key,
                `Unable to inspect native database data path: ${error.message}`,
                error,
              ),
            ),
          )
      : false;
    if (initialized && !completeInitialization)
      yield* fileSystem
        .remove(dataPath, { recursive: true, force: true })
        .pipe(
          Effect.mapError((error) =>
            driverError(
              key,
              `Unable to remove incomplete native database data path: ${error.message}`,
              error,
            ),
          ),
        );
    const migrationsPath = pathService.join(artifactRoot, "share/supabase-cli/migrations");
    const artifactBin = pathService.join(artifactRoot, "bin");
    const hostPath = yield* Config.string("PATH").pipe(
      Config.withDefault(""),
      Effect.mapError((error) => driverError(key, "Unable to read host PATH", error)),
    );
    return {
      executable: pathService.join(migrationsPath, "migrate.sh"),
      cwd: migrationsPath,
      // Migration can legitimately outlive readiness on a cold machine; its marker is
      // written only after success, so rerunning remains idempotent when the marker is absent.
      timeout: "15 minutes",
      successMarker: markerPath,
      env: {
        ...environment,
        PATH: hostPath.length === 0 ? artifactBin : `${artifactBin}:${hostPath}`,
        POSTGRES_HOST: "127.0.0.1",
        POSTGRES_PORT: String(endpointPort),
        POSTGRES_DB: "postgres",
        POSTGRES_USER: "supabase_admin",
        POSTGRES_PASSWORD: environment.POSTGRES_PASSWORD ?? "",
      },
    };
  });

declare const SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE: string | undefined;

// Release builds inject the already-bundled Edge Runtime entrypoint. The
// source-only fallback keeps local development/tests convenient while keeping
// esbuild out of the shipped supervisor's runtime dependency graph.
const bootstrapContent =
  typeof SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE === "string"
    ? Effect.succeed(SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE)
    : Effect.tryPromise({
        try: () =>
          import("../functions/serve-main-bundler.ts").then(({ bundleServeMainTemplate }) =>
            bundleServeMainTemplate(),
          ),
        catch: (cause) => preparationError("Unable to bundle functions bootstrap", cause),
      });

const mapDriverError = (
  key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">,
  error: unknown,
): RuntimeDriverError =>
  driverError(key, error instanceof Error ? error.message : "Runtime operation failed", error);

/** Ensures owner files are attempted even when the selected runtime cleanup fails. */
export const withOwnedRuntimeFileCleanup = (
  driver: RuntimeDriver,
  envFiles: RuntimeEnvFileOwner,
  functionsBootstrap: FunctionsBootstrapOwner,
  inputOwner?: RuntimeInputOwner,
  preparationCleanup?: Effect.Effect<void, StackError>,
): RuntimeDriver => {
  const cleanupFiles = (stackId: StackId): Effect.Effect<void, RuntimeDriverError> =>
    Effect.gen(function* () {
      const key = { stackId, workloadId: "" };
      let cleanupCause: Cause.Cause<RuntimeDriverError> = Cause.empty;
      const attempts: ReadonlyArray<Effect.Effect<void, RuntimeDriverError>> = [
        ...(preparationCleanup === undefined
          ? []
          : [
              preparationCleanup.pipe(
                Effect.mapError((error) =>
                  driverError(key, "Unable to clean runtime preparation", error),
                ),
              ),
            ]),
        envFiles.cleanupAll.pipe(
          Effect.mapError((error) => driverError(key, "Unable to clean runtime files", error)),
        ),
        functionsBootstrap.cleanupAll.pipe(
          Effect.mapError((error) => driverError(key, "Unable to clean runtime files", error)),
        ),
        ...(inputOwner === undefined
          ? []
          : [
              inputOwner.cleanupAll.pipe(
                Effect.mapError((error) =>
                  driverError(key, "Unable to clean runtime files", error),
                ),
              ),
            ]),
      ];
      for (const attempt of attempts) {
        const result = yield* Effect.exit(attempt);
        if (Exit.isFailure(result)) cleanupCause = Cause.combine(cleanupCause, result.cause);
      }
      if (cleanupCause.reasons.length > 0) return yield* Effect.failCause(cleanupCause);
    });
  return {
    ...driver,
    cleanup: (request) =>
      Effect.gen(function* () {
        const runtime = yield* Effect.exit(driver.cleanup(request));
        const files = yield* Effect.exit(cleanupFiles(request.stackId));
        if (Exit.isFailure(runtime) && Exit.isFailure(files))
          return yield* Effect.failCause(Cause.combine(runtime.cause, files.cause));
        if (Exit.isFailure(runtime)) return yield* Effect.failCause(runtime.cause);
        if (Exit.isFailure(files)) return yield* Effect.failCause(files.cause);
      }),
  };
};

/** Composes concrete runtime owners around one persisted stack identity. */
export const makeProductionRuntime = (
  options: ProductionRuntimeOptions,
): Effect.Effect<
  SupervisorRuntime,
  StackError,
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const state = yield* currentStateReader(options);
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const paths = yield* resolveStackPaths({
      stateRoot: options.stateRoot,
      stackId: options.stackId,
    }).pipe(
      Effect.mapError((error) => preparationError("Unable to resolve stack runtime paths", error)),
    );
    const fetchJson: RuntimeJsonFetcher =
      options.fetchJson ??
      ((url) =>
        // oxlint-disable effecttsgo/async-function -- production fetch leaf owns AbortSignal.
        // oxlint-disable effecttsgo/global-fetch-in-effect -- production fetch leaf is the network boundary.
        Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(url, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
          },
          catch: (cause) => preparationError("Unable to fetch Auth OIDC metadata", cause),
        }));
    // oxlint-enable effecttsgo/async-function
    // oxlint-enable effecttsgo/global-fetch-in-effect
    const inputOwner = yield* makeRuntimeInputOwner({
      stateRoot: options.stateRoot,
      stackId: options.stackId,
      fetchJson,
    });
    const hostRoute = yield* Ref.make<ContainerHostRoute | undefined>(undefined);
    const ingress =
      options.ingress ??
      (yield* makeSupervisorIngress({
        stackId: options.stackId,
        stateRoot: options.stateRoot,
        store: options.stateStore,
        context: options.context,
        resolveAuthTemplates: inputOwner.resolveAuthTemplates,
        resolveInternalApiBindAddress: () =>
          Ref.get(hostRoute).pipe(Effect.map((route) => route?.bindAddress)),
      }));
    const envFiles =
      options.envFileOwner ??
      (yield* makeRuntimeEnvFileOwner({ stateRoot: options.stateRoot, stackId: options.stackId }));
    const functionsBootstrap =
      options.functionsBootstrapOwner ??
      (yield* makeFunctionsBootstrapOwner({
        stateRoot: options.stateRoot,
        stackId: options.stackId,
      }));
    const knownSecrets = yield* Ref.make<ReadonlySet<string>>(new Set(stateSecrets(state)));
    const logStoreInitialization = yield* Effect.result(
      options.logStore === undefined
        ? makeLogStore({ path: paths.logs, knownSecrets: stateSecrets(state) })
        : Effect.succeed(options.logStore),
    );
    const logStoreInitializationFailure = Result.isFailure(logStoreInitialization)
      ? logStoreInitialization.failure
      : undefined;
    const baseLogs: LogStore = Result.isSuccess(logStoreInitialization)
      ? logStoreInitialization.success
      : unavailableLogStore(logStoreInitialization.failure, paths.logs);
    const logs = dynamicLogStore(baseLogs, knownSecrets);
    const selectedEngine = state.runtime.kind === "container" ? state.runtime.engine : undefined;
    const containerEngine =
      options.containerEngine ??
      (selectedEngine === undefined
        ? undefined
        : yield* resolveContainerEngine(selectedEngine).pipe(
            Effect.mapError((error) =>
              containerEngineError(
                selectedEngine,
                `Unable to configure ${selectedEngine} artifact engine`,
                error,
              ),
            ),
          ));
    const preparer =
      options.artifactPreparer ??
      (yield* makeProductionRuntimeArtifactPreparer({
        stateRoot: options.stateRoot,
        artifactCacheRoot: options.artifactCacheRoot,
        runtime: state.runtime,
        ...(containerEngine === undefined ? {} : { containerEngine }),
      }));
    const serveTemplate = yield* Effect.cached(bootstrapContent);
    const bootstrapDatabase =
      options.bootstrapDatabase ?? ((state: PersistedStackState) => bootstrapDatabaseAt(state));

    const artifacts = new Map<string, PreparedWorkloadArtifact>();
    const preparationStatuses = new Map<string, ArtifactPreparationStatus>();
    const recordPreparationProgress = (progress: RuntimeArtifactPreparationProgress): void => {
      preparationStatuses.set(progress.workloadId, {
        workloadId: progress.workloadId,
        capability: progress.capability,
        state: progress.state,
        ...(progress.error === undefined ? {} : { error: progress.error }),
      });
    };
    const queuePreparation = (workload: PlannedWorkload): void => {
      if (artifacts.has(artifactKey(state.runtime, workload))) return;
      const current = preparationStatuses.get(workload.id);
      if (current?.state === "preparing" || current?.state === "downloading") return;
      recordPreparationProgress({
        workloadId: workload.id,
        capability: workload.capability,
        state: "queued",
      });
    };
    const preparationGate = yield* Semaphore.make(1);
    const parentScope = yield* Scope.Scope;
    let preparationScope: Scope.Scope | undefined;
    const preparationInFlight = new Map<
      string,
      Fiber.Fiber<PreparedWorkloadArtifact, StackError>
    >();
    yield* Scope.addFinalizer(
      parentScope,
      Effect.suspend(() =>
        preparationScope === undefined ? Effect.void : Scope.close(preparationScope, Exit.void),
      ),
    );
    // Runtime input materialization writes shared files and populates completed caches. Keep
    // that short preparation boundary serialized while allowing the actual workloads to start
    // concurrently after their inputs are ready.
    const runtimeInputGate = yield* Semaphore.make(1);
    const freshState = (key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">) =>
      currentStateReader(options).pipe(
        Effect.mapError((error) => mapDriverError(key, error)),
        Effect.flatMap((fresh) =>
          runtimeMatches(fresh.runtime, state.runtime)
            ? Effect.succeed(fresh)
            : Effect.fail(driverError(key, "Persisted runtime changed while owner was active")),
        ),
      );
    const prepareOne = (
      runtime: StackRuntime,
      workload: PlannedWorkload,
      onProgress?: RuntimeArtifactPreparationProgressListener,
    ) => {
      return Effect.suspend(() => {
        const key = artifactKey(runtime, workload);
        const cached = artifacts.get(key);
        return cached === undefined
          ? Effect.sync(() =>
              onProgress?.({
                workloadId: workload.id,
                capability: workload.capability,
                state: "preparing",
              }),
            ).pipe(
              Effect.andThen(preparer.prepare(runtime, workload, onProgress)),
              Effect.tap((prepared) =>
                Effect.sync(() => {
                  artifacts.set(key, prepared);
                  onProgress?.({
                    workloadId: workload.id,
                    capability: workload.capability,
                    state: "ready",
                  });
                }),
              ),
              Effect.tapError((error) =>
                Effect.sync(() =>
                  onProgress?.({
                    workloadId: workload.id,
                    capability: workload.capability,
                    state: "failed",
                    error: error.message,
                  }),
                ),
              ),
            )
          : Effect.succeed(cached);
      });
    };
    const prepare = (
      runtime: StackRuntime,
      workload: PlannedWorkload,
      onProgress?: RuntimeArtifactPreparationProgressListener,
    ) =>
      Effect.gen(function* () {
        const key = artifactKey(runtime, workload);
        const joined = yield* Effect.uninterruptible(
          preparationGate.withPermit(
            Effect.gen(function* () {
              const existing = preparationInFlight.get(key);
              if (existing !== undefined) return existing;
              const scope = preparationScope ?? (preparationScope = yield* Scope.make("parallel"));
              let fiber: Fiber.Fiber<PreparedWorkloadArtifact, StackError> | undefined;
              const owner = prepareOne(runtime, workload, onProgress).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (preparationInFlight.get(key) === fiber) preparationInFlight.delete(key);
                  }),
                ),
              );
              fiber = yield* Effect.forkIn(owner, scope, { startImmediately: false });
              preparationInFlight.set(key, fiber);
              return fiber;
            }),
          ),
        );
        return yield* Fiber.join(joined);
      });
    const prepareArtifacts = (
      runtime: StackRuntime,
      workloads: ReadonlyArray<PlannedWorkload>,
      onProgress?: RuntimeArtifactPreparationProgressListener,
    ) =>
      Effect.forEach(workloads, (workload) => prepare(runtime, workload, onProgress), {
        concurrency: 4,
      });
    const prepareFor = (
      input: LifecycleInput,
      selected: ReadonlySet<CapabilityName>,
    ): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        const workloads = input.plan.workloads.filter((workload) =>
          selected.has(workload.capability),
        );
        for (const workload of workloads) queuePreparation(workload);
        yield* prepareArtifacts(input.state.runtime, workloads, recordPreparationProgress);
      });
    const logPreparationFailure = (message: string): Effect.Effect<void> =>
      logs.append({ source: "supervisor", stream: "internal", message }).pipe(Effect.ignore);
    const prefetch = (persisted: PersistedStackState): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (persisted.definition === undefined || persisted.definition.preparation === "on-demand")
          return;
        const plan = yield* rebuildExecutionPlan(persisted.runtime, persisted.definition).pipe(
          Effect.mapError((error) =>
            preparationError("Unable to plan background preparation", error),
          ),
        );
        const workloads = plan.workloads.filter(
          (workload) =>
            persisted.definition?.capabilities[workload.capability].activation === "lazy" &&
            !artifacts.has(artifactKey(persisted.runtime, workload)),
        );
        for (const workload of workloads) queuePreparation(workload);
        yield* Effect.forEach(
          workloads,
          (workload) =>
            prepare(persisted.runtime, workload, recordPreparationProgress).pipe(
              Effect.catch((error) =>
                logPreparationFailure(
                  `Background preparation failed for ${workload.id}: ${error.message}`,
                ),
              ),
            ),
          { concurrency: 2, discard: true },
        );
      }).pipe(
        Effect.catch((error) =>
          logPreparationFailure(
            `Background preparation failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      );
    const cleanupPreparation: Effect.Effect<void, StackError> = Effect.gen(function* () {
      const scope = yield* preparationGate.withPermit(
        Effect.sync(() => {
          const current = preparationScope;
          preparationScope = undefined;
          preparationInFlight.clear();
          return current;
        }),
      );
      if (scope !== undefined) yield* Scope.close(scope, Exit.interrupt());
      yield* Effect.sync(() => {
        preparationInFlight.clear();
        preparationStatuses.clear();
        artifacts.clear();
      });
    }).pipe(Effect.uninterruptible);
    const functionsPath = (): Effect.Effect<string, StackPreparationError> =>
      serveTemplate.pipe(Effect.flatMap((content) => functionsBootstrap.write({ content })));
    const runtimeInputs = (
      workload: PlannedWorkload,
      fresh: PersistedStackState,
      host: ContainerHostRoute | undefined,
    ): Effect.Effect<WorkloadRuntimeInputs, StackPreparationError> =>
      runtimeInputGate.withPermit(
        Effect.gen(function* () {
          const material = yield* inputOwner.resolve(fresh, workload.id);
          const templates = material.auth?.templates;
          const apiListener = fresh.definition?.listeners.api;
          const apiAssignment = fresh.ports.find((assignment) => assignment.field === "api");
          const templateBaseUrl =
            workload.id !== "auth:auth" || templates === undefined || templates.length === 0
              ? undefined
              : apiListener?.enabled !== true || apiAssignment === undefined
                ? yield* preparationError(
                    "Configured Auth email templates require a public API listener",
                  )
                : `http://${urlHost(host?.host ?? apiListener.address)}:${apiAssignment.port}`;
          const auth =
            material.auth === undefined
              ? undefined
              : {
                  ...material.auth,
                  ...(templateBaseUrl === undefined ? {} : { templateBaseUrl }),
                };
          const functions =
            workload.id === "functions:edge-runtime"
              ? {
                  bootstrapPath: yield* functionsPath(),
                  ...(material.functions?.secrets === undefined
                    ? {}
                    : { secrets: material.functions.secrets }),
                }
              : undefined;
          return {
            ...(auth === undefined ? {} : { auth }),
            ...(workload.id.startsWith("analytics:") && material.analytics !== undefined
              ? { analytics: material.analytics }
              : {}),
            ...(workload.id === "pooler:pooler" && material.pooler !== undefined
              ? { pooler: material.pooler }
              : {}),
            database: { dataPath: pathService.join(paths.data, "database") },
            storage: { dataPath: pathService.join(paths.data, "storage") },
            ...(functions === undefined ? {} : { functions }),
            ...(host === undefined ? {} : { hostRoute: host }),
          };
        }),
      );

    const preflight = (input: LifecycleInput): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        if (logStoreInitializationFailure !== undefined)
          return yield* preparationError(
            `Unable to open stack logs: ${logStoreInitializationFailure.message}`,
            logStoreInitializationFailure,
          );
        if (!runtimeMatches(input.state.runtime, state.runtime))
          return yield* new StackRuntimeMismatchError({
            message: "Lifecycle runtime does not match persisted runtime",
          });
        // Remember candidate secrets before any runtime preflight work can emit logs.
        yield* rememberSecrets(knownSecrets, input.state.secrets);
        yield* rememberSecrets(knownSecrets, input.secrets);
        // Eagerly validate the candidate before any engine/artifact work. Start-time checks
        // below revalidate the fresh persisted definition because it is runtime authority.
        yield* validateDatabaseReadinessBudget(input.definition, input.plan.workloads);
        const candidateState: PersistedStackState = {
          ...input.state,
          definition: input.definition,
          secrets: input.secrets,
        };
        yield* Effect.forEach(input.plan.workloads, (workload) =>
          validateMaterializedSecrets(candidateState, workload.capability),
        );
        yield* Effect.forEach(input.plan.workloads, (workload) =>
          Effect.gen(function* () {
            if (runtimeSpecFor(workload) === undefined)
              return yield* preparationError(`Unknown runtime specification for ${workload.id}`);
            if (workload.selected.kind !== input.state.runtime.kind)
              return yield* preparationError(`Runtime artifact mismatch for ${workload.id}`);
          }),
        );
        if (input.state.runtime.kind === "container") {
          const engineKind = input.state.runtime.engine;
          if (containerEngine === undefined || containerEngine.kind !== engineKind)
            return yield* containerEngineError(
              engineKind,
              "Selected container engine is unavailable",
            );
          const route = yield* containerEngine.preflight.pipe(
            Effect.mapError((error) =>
              containerEngineError(engineKind, "Container host route preflight failed", error),
            ),
          );
          yield* Ref.set(hostRoute, route);
        }
        if (input.state.runtime.kind === "native") {
          for (const assignment of input.state.ports) {
            const listener = input.definition.listeners[assignment.field];
            if (
              !listener.enabled ||
              (listener.port === "automatic"
                ? assignment.intent !== "automatic"
                : listener.port !== assignment.port)
            )
              continue;
            yield* checkHostPort(listener.address, assignment.port, assignment.field).pipe(
              Effect.mapError(
                (error) =>
                  new PortUnavailableError({
                    field: assignment.field,
                    port: assignment.port,
                    message: `Persisted ${assignment.field} port is unavailable`,
                    cause: error,
                  }),
              ),
            );
          }
          for (const assignment of input.state.privatePorts)
            yield* checkHostPort(
              "127.0.0.1",
              assignment.port,
              `${assignment.workloadId}:${assignment.binding}`,
            );
          yield* checkNativeDatabaseLockEvidence(
            fileSystem,
            pathService.join(paths.data, "database", "postmaster.pid"),
          );
        }
        const eager = eagerCapabilities(input.plan);
        const eagerWorkloads = input.plan.workloads.filter((workload) =>
          eager.has(workload.capability),
        );
        for (const workload of eagerWorkloads) queuePreparation(workload);
        yield* prepareArtifacts(input.state.runtime, eagerWorkloads, recordPreparationProgress);
      });

    const activate = (
      capability: CapabilityName,
      input: LifecycleInput,
    ): Effect.Effect<
      { readonly host: string; readonly port: number },
      GatewayActivationError | StackError
    > =>
      Effect.gen(function* () {
        const workload = input.plan.workloads.find(
          (entry) => entry.capability === capability && entry.readiness.portField !== undefined,
        );
        if (workload === undefined)
          return yield* new GatewayActivationError({
            message: `Capability ${capability} has no workload`,
          });
        const fresh = yield* freshState({
          stackId: options.stackId,
          workloadId: workload.id,
        }).pipe(Effect.mapError((error) => new GatewayActivationError({ message: error.message })));
        const spec = runtimeSpecFor(workload);
        if (spec === undefined)
          return yield* new GatewayActivationError({
            message: `Unknown runtime specification for ${workload.id}`,
          });
        yield* validatePrivateAssignments(fresh, workload).pipe(
          Effect.mapError((error) => new GatewayActivationError({ message: error.message })),
        );
        const endpoint = spec.privateEndpoint(fresh, spec.readiness.binding, "native");
        if (endpoint === undefined)
          return yield* new GatewayActivationError({
            message: `Missing private endpoint for ${workload.id}`,
          });
        return endpoint;
      });

    const waitForReadiness = (key: RuntimeWorkloadKey, workload: PlannedWorkload) =>
      freshState(key).pipe(
        Effect.flatMap((fresh) => readinessFor(fresh, workload)),
        Effect.mapError((error) => mapDriverError(key, error)),
      );
    const bootstrapWorkloadDatabase = (key: RuntimeWorkloadKey, workload: PlannedWorkload) =>
      workload.bootstrap === "database"
        ? freshState(key).pipe(
            Effect.flatMap((fresh) =>
              readinessDeadlineFor(fresh, workload).pipe(
                Effect.flatMap((deadline) =>
                  Effect.timeout(
                    Effect.retry(
                      Effect.suspend(() => bootstrapDatabase(fresh)),
                      {
                        schedule: Schedule.spaced("100 millis"),
                        while: (error) =>
                          error instanceof DatabaseBootstrapError && error.retryable === true,
                      },
                    ),
                    deadline,
                  ),
                ),
              ),
            ),
            Effect.mapError((error) => mapDriverError(key, error)),
          )
        : Effect.void;

    let driver: RuntimeDriver;
    if (state.runtime.kind === "native") {
      driver = yield* makeNativeRuntime({
        resolveProcess: (key, workload) =>
          freshState(key).pipe(
            Effect.flatMap((fresh) =>
              Effect.gen(function* () {
                const spec = runtimeSpecFor(workload);
                if (spec === undefined)
                  return yield* driverError(
                    key,
                    `Unknown runtime specification for ${workload.id}`,
                  );
                const readinessBudget = yield* readinessDeadlineFor(fresh, workload).pipe(
                  Effect.mapError((error) => mapDriverError(key, error)),
                );
                // Revalidate the fresh persisted definition before spawning; preflight checks
                // the candidate definition, while this state is the runtime authority.
                const inputs = yield* runtimeInputs(workload, fresh, undefined).pipe(
                  Effect.mapError((error) => mapDriverError(key, error)),
                );
                yield* validateWorkloadRuntimeInputs(fresh, workload, inputs).pipe(
                  Effect.mapError((error) => mapDriverError(key, error)),
                );
                yield* validatePrivateAssignments(fresh, workload).pipe(
                  Effect.mapError((error) => mapDriverError(key, error)),
                );
                const prepared = yield* prepare(fresh.runtime, workload).pipe(
                  Effect.mapError((error) => mapDriverError(key, error)),
                );
                if (prepared.artifactRoot === undefined)
                  return yield* driverError(
                    key,
                    `Native artifact root is unavailable for ${workload.id}`,
                  );
                const endpoint = spec.privateEndpoint(fresh, spec.readiness.binding, "native");
                if (endpoint === undefined)
                  return yield* driverError(
                    key,
                    `Missing private port assignment for ${workload.id}`,
                  );
                const resolvedNativeProcess = spec.nativeProcess(
                  prepared.artifactRoot,
                  fresh,
                  workload,
                  endpoint.port,
                  inputs,
                );
                const environment = spec.env(fresh, workload, endpoint.port, "native", inputs);
                let migration: NativeProcessSpec | undefined;
                if (isDatabaseWorkload(workload)) {
                  const dataPath = inputs.database?.dataPath;
                  if (dataPath === undefined)
                    return yield* driverError(
                      key,
                      "Resolved database data path is unavailable for native migration",
                    );
                  migration = yield* prepareNativeDatabaseMigration({
                    key,
                    dataPath,
                    artifactRoot: prepared.artifactRoot,
                    environment,
                    endpointPort: endpoint.port,
                    fileSystem,
                    pathService,
                  });
                }
                return {
                  startup: spec
                    .nativeStartupProcesses(
                      prepared.artifactRoot,
                      fresh,
                      workload,
                      endpoint.port,
                      inputs,
                    )
                    .map((startup: NativeProcessSpec) => ({
                      ...startup,
                      timeout:
                        startup.timeout ??
                        (isDatabaseWorkload(workload) ? readinessBudget : Duration.minutes(5)),
                      env: { ...environment, ...startup.env },
                    })),
                  ...(migration === undefined ? {} : { postReadiness: [migration] }),
                  main: { ...resolvedNativeProcess, env: environment },
                };
              }),
            ),
          ),
        waitForReadiness,
        bootstrapDatabase: bootstrapWorkloadDatabase,
        logStore: logs,
      }).pipe(
        Effect.mapError((error) => preparationError("Unable to initialize native runtime", error)),
      );
    } else {
      if (containerEngine === undefined || containerEngine.kind !== state.runtime.engine)
        return yield* containerEngineError(
          state.runtime.engine,
          "Selected container engine is unavailable",
        );
      driver = yield* makeContainerRuntime({
        engine: containerEngine,
        ownerSessionId: options.ownerSessionId,
        resolveWorkload: (key, workload) =>
          freshState(key).pipe(
            Effect.flatMap((fresh) =>
              Effect.gen(function* () {
                const spec = runtimeSpecFor(workload);
                if (spec === undefined)
                  return yield* driverError(
                    key,
                    `Unknown runtime specification for ${workload.id}`,
                  );
                yield* readinessDeadlineFor(fresh, workload).pipe(
                  Effect.mapError((error) => mapDriverError(key, error)),
                );
                let route = yield* Ref.get(hostRoute);
                if (route === undefined) {
                  route = yield* containerEngine.preflight.pipe(
                    Effect.mapError((error) =>
                      mapDriverError(
                        key,
                        containerEngineError(
                          containerEngine.kind,
                          "Container host route preflight failed",
                          error,
                        ),
                      ),
                    ),
                  );
                  yield* Ref.set(hostRoute, route);
                }
                const inputs = yield* runtimeInputs(workload, fresh, route).pipe(
                  Effect.mapError((error) => mapDriverError(key, error)),
                );
                const resolution = yield* resolveContainerResolutionFor(
                  fresh,
                  workload,
                  inputs,
                ).pipe(Effect.mapError((error) => mapDriverError(key, error)));
                if (resolution === undefined)
                  return yield* driverError(
                    key,
                    `Unknown container runtime specification for ${workload.id}`,
                  );
                const envFile = yield* envFiles
                  .write({
                    workloadId: workload.id,
                    values: resolution.env,
                  })
                  .pipe(Effect.mapError((error) => mapDriverError(key, error)));
                const volume =
                  workload.id === "database:database"
                    ? { target: "/var/lib/postgresql/data", readOnly: false }
                    : workload.id === "storage:storage"
                      ? {
                          target: "/mnt",
                          readOnly: false,
                          ownerWorkloadId: "storage:storage",
                        }
                      : workload.id === "storage:imgproxy"
                        ? {
                            target: "/mnt",
                            readOnly: true,
                            ownerWorkloadId: "storage:storage",
                          }
                        : undefined;
                const { env: _env, ...withoutEnv } = resolution;
                return {
                  ...withoutEnv,
                  envFile,
                  ...(volume === undefined ? {} : { volume }),
                } satisfies ContainerWorkloadResolution;
              }),
            ),
          ),
        waitForReadiness,
        bootstrapDatabase: bootstrapWorkloadDatabase,
        onNetworkReady: (network) => {
          const resolveGateway = containerEngine.resolveNetworkGateway;
          if (resolveGateway === undefined) return Effect.succeed(false);
          return resolveGateway(network.id).pipe(
            Effect.mapError(
              (error) =>
                new RuntimeDriverError({
                  message: "Unable to resolve container network gateway",
                  stackId: options.stackId,
                  workloadId: network.name,
                  cause: error,
                }),
            ),
            Effect.flatMap((gateway) =>
              Effect.gen(function* () {
                const current = yield* Ref.get(hostRoute);
                if (current?.host === gateway && current.bindAddress === gateway) return false;
                yield* Ref.set(hostRoute, { host: gateway, bindAddress: gateway });
                return true;
              }),
            ),
          );
        },
        logStore: logs,
      });
    }
    const baseDriver = withOwnedRuntimeFileCleanup(
      driver,
      envFiles,
      functionsBootstrap,
      inputOwner,
      cleanupPreparation,
    );
    return {
      driver: baseDriver,
      preflight,
      prepare: prepareFor,
      prefetch,
      artifacts: Effect.sync(() => [...preparationStatuses.values()]),
      activate,
      ingress,
      logStore: logs,
    } satisfies SupervisorRuntime;
  });

const containerEngineError = (
  engine: ContainerEngineKind,
  message: string,
  cause?: unknown,
): ContainerEngineError =>
  new ContainerEngineError({ engine, message, ...(cause === undefined ? {} : { cause }) });
