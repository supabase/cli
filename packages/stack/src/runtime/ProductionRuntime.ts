import { NodeHttpClient } from "@effect/platform-node";
import { HttpClient } from "effect/unstable/http";
import {
  Cause,
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
  Predicate,
  Redacted,
  PlatformError,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { RuntimeArtifactInput } from "../preparation/RuntimeArtifacts.ts";
import { createExecutionPlan } from "../model/Compiler.ts";
import { CAPABILITY_MODULES } from "../model/ExecutionPlan.ts";
import {
  makeFunctionsBootstrapOwner,
  type FunctionsBootstrapOwner,
} from "../functions/FunctionsBootstrap.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import {
  resolveServiceInstancePaths,
  resolveStackPaths,
  type ServiceInstancePaths,
} from "../state/Paths.ts";
import { redactKnownSecrets } from "../state/SecretStore.ts";
import { privateBindingKey, type PersistedStackState } from "../state/StackState.ts";
import type { PersistedSecretValues } from "../state/StackState.ts";
import type { PersistedServiceInstance } from "../model/ServiceRegistry.ts";
import type { StackId } from "../public/StackId.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { InstanceArtifactPreparationStatus } from "../public/Status.ts";
import type { CapabilityName } from "../public/Capability.ts";
import {
  GatewayActivationError,
  StackPreparationError,
  ContainerEngineError,
  PortUnavailableError,
  StackRuntimeMismatchError,
  StackRuntimeError,
  StackCleanupError,
  StackLifecycleConflictError,
  StackStateInvalidError,
  UnsupportedSnapshotError,
  isStackError,
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
import type { InstanceRuntimeInput, LifecycleInput } from "../supervisor/Lifecycle.ts";
import type { BackendEndpoint } from "../gateway/Gateway.ts";
import type { RuntimeBindingPublication } from "./RuntimeBinding.ts";
import type { PrepareResult } from "../public/Service.ts";
import { makePostgresInstanceRuntime } from "./PostgresInstanceRuntime.ts";
import type {
  CatalogInitializationRecipe,
  CatalogInitializationResult,
} from "./PostgresInstanceRuntime.ts";
import type { SupervisorRuntime } from "../supervisor/Supervisor.ts";
import {
  makeProductionRuntimeArtifactPreparer,
  type RuntimeArtifactPreparationProgress,
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
  privateBindingIntentsFor,
  runtimeSpecFor,
  validatePrivateAssignments,
  validateWorkloadRuntimeInputs,
  functionOverridesForSettings,
  type WorkloadRuntimeInputs,
} from "./WorkloadRuntimeSpec.ts";
import { makeNativeRuntime } from "./NativeRuntime.ts";
import {
  makeContainerRuntime,
  type ContainerWorkloadResolution,
  catalogInitContainerName,
  workloadVolumeName,
} from "./ContainerRuntime.ts";
import {
  DEFAULT_READINESS_DEADLINE,
  probeReadiness,
  type ReadinessTarget,
} from "./ReadinessProbe.ts";
import { parseGoDuration } from "../model/capabilities/database.ts";
import type {
  ContainerEngine,
  ContainerEngineFailure,
  ContainerEngineKind,
  ContainerHostRoute,
  ContainerResource,
  ContainerVolumeLabels,
} from "./ContainerEngine.ts";
import { ContainerCommandError } from "./ContainerEngine.ts";
import { resolveContainerEngine } from "./ContainerEngineResolver.ts";
import { bootstrapDatabaseAt, bootstrapManagedPostgres } from "./PostgresDatabaseSession.ts";
import { databaseBootstrapPlan } from "./DatabaseBootstrapCatalog.ts";
import { catalogEntryFor } from "../model/WorkloadCatalog.ts";
import { DatabaseBootstrapError } from "../model/DatabaseBootstrap.ts";
import {
  rewriteCatalogDatabaseEnvironment,
  runCatalogNativeProcess,
} from "./CatalogInitialization.ts";
import { runContainerStartupProcess } from "./ContainerRuntime.ts";
import { validateMaterializedSecrets } from "../state/MaterializedSettings.ts";
import { valueAt } from "../state/MaterializedSettings.ts";
import { isRecord, settingValue, settingsForInstance } from "../state/MaterializedSettings.ts";
import {
  planFunctionFiles,
  type FunctionFile,
  type FunctionFilesPlan,
} from "../functions/FunctionFiles.ts";
import {
  resolveFunctionConfigs,
  type FunctionFileSystem,
  FunctionFileSystemError,
} from "../functions/serve-main-resolver.ts";
import {
  RuntimeDriverError,
  type RuntimeDriver,
  type RuntimeStartOptions,
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
  /** Runs one configured catalog recipe against the supplied instance endpoint. */
  readonly reconcileCatalogRecipe?: (
    input: InstanceRuntimeInput,
    recipe: CatalogInitializationRecipe,
    endpoint: BackendEndpoint,
  ) => Effect.Effect<CatalogInitializationResult, StackError>;
}

const preparationError = (message: string, cause?: unknown): StackPreparationError =>
  new StackPreparationError({ message, ...(cause === undefined ? {} : { cause }) });

const unavailableLogStore = (error: LogStoreError, path: string): LogStore => ({
  path,
  append: () => Effect.fail(error),
  read: () => Effect.fail(error),
});

const driverError = (
  key: Pick<RuntimeWorkloadKey, "stackId"> &
    Partial<Pick<RuntimeWorkloadKey, "instanceId" | "workloadId">>,
  message: string,
  cause?: unknown,
): RuntimeDriverError =>
  new RuntimeDriverError({
    message,
    stackId: key.stackId,
    ...(key.instanceId === undefined ? {} : { instanceId: key.instanceId }),
    ...(key.workloadId === undefined ? {} : { workloadId: key.workloadId }),
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

const artifactKey = (runtime: StackRuntime, workload: RuntimeArtifactInput): string =>
  `${runtime.kind}:${runtime.kind === "container" ? runtime.engine : ""}:${workload.recipeId}:${workload.selected.kind === "native" ? workload.selected.release : workload.selected.image}`;

const runtimeMatches = (left: StackRuntime, right: StackRuntime): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "native" || right.kind === "native") return true;
  return left.engine === right.engine;
};

const urlHost = (host: string): string => {
  const normalized = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
};

// Native cold starts can spend more than 30 seconds loading shared libraries before serving.
const NATIVE_READINESS_DEADLINE = Duration.minutes(2);
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
  workload.capability === "database";
const configuredDatabaseReadinessDeadline = (
  state: PersistedStackState,
): Effect.Effect<Duration.Duration, StackPreparationError> => {
  const configured = valueAt(state, "database", "health_timeout");
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
    ? configuredDatabaseReadinessDeadline(state)
    : Effect.succeed(
        state.runtime.kind === "native" ? NATIVE_READINESS_DEADLINE : DEFAULT_READINESS_DEADLINE,
      );

const validateDatabaseReadinessBudget = (
  state: PersistedStackState,
  workloads: ReadonlyArray<PlannedWorkload>,
): Effect.Effect<void, StackPreparationError> =>
  workloads.some(isDatabaseWorkload)
    ? configuredDatabaseReadinessDeadline(state).pipe(Effect.asVoid)
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

const hasInspectorTarget = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "webSocketDebuggerUrl" in entry &&
      typeof entry.webSocketDebuggerUrl === "string" &&
      entry.webSocketDebuggerUrl.length > 0,
  );

const probeInspectorReadiness = (
  target: ReadinessTarget,
  deadline: Duration.Duration,
): Effect.Effect<void, RuntimeDriverError> => {
  const attempt = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(
      `http://${urlHost(target.host)}:${target.port}${target.path ?? "/"}`,
    );
    const body = yield* response.json;
    if (response.status < 200 || response.status >= 300 || !hasInspectorTarget(body))
      return yield* new RuntimeDriverError({
        message: "Inspector target is not ready",
        target,
      });
  }).pipe(
    Effect.mapError((error) =>
      error instanceof RuntimeDriverError
        ? error
        : new RuntimeDriverError({
            message: "Inspector readiness request failed",
            target,
            cause: error,
          }),
    ),
  );
  return Effect.timeoutOrElse(Effect.retry(attempt, Schedule.spaced("100 millis")), {
    duration: deadline,
    orElse: () =>
      Effect.fail(
        new RuntimeDriverError({
          message: "Inspector target readiness deadline exceeded",
          target,
        }),
      ),
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
};

declare const SUPABASE_STACK_FUNCTIONS_SERVE_MAIN_TEMPLATE: string | undefined;

// Release builds inject the already-bundled Edge Runtime entrypoint. The
// source-only fallback keeps local development/tests convenient while keeping
// esbuild out of the shipped supervisor's runtime dependency graph.
const bootstrapContent =
  typeof SUPABASE_STACK_FUNCTIONS_SERVE_MAIN_TEMPLATE === "string"
    ? Effect.succeed(SUPABASE_STACK_FUNCTIONS_SERVE_MAIN_TEMPLATE)
    : Effect.tryPromise({
        try: () => import("../functions/serve-main-bundler.ts"),
        catch: (cause) => preparationError("Unable to bundle functions bootstrap", cause),
      }).pipe(
        Effect.flatMap(({ bundleServeMainTemplate }) =>
          bundleServeMainTemplate.pipe(
            Effect.mapError((cause) =>
              preparationError("Unable to bundle functions bootstrap", cause),
            ),
          ),
        ),
      );

const mapDriverError = (
  key: Pick<RuntimeWorkloadKey, "stackId" | "instanceId" | "workloadId">,
  error: unknown,
): RuntimeDriverError =>
  driverError(key, error instanceof Error ? error.message : "Runtime operation failed", error);

const isNotSymbolicLink = (error: PlatformError.PlatformError): boolean => {
  if (!(error.reason instanceof PlatformError.SystemError) || error.reason._tag !== "Unknown")
    return false;
  const cause = error.reason.cause;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EINVAL";
};

const makeFunctionFileSystem = (fs: FileSystem.FileSystem): FunctionFileSystem => ({
  lstat: (pathname) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(pathname);
      const isSymbolicLink = yield* fs.readLink(pathname).pipe(
        Effect.as(true),
        Effect.catchTag("PlatformError", (error) =>
          isNotSymbolicLink(error) ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
      return {
        isDirectory: info.type === "Directory",
        isFile: info.type === "File",
        isSymbolicLink,
      };
    }).pipe(Effect.mapError((cause) => new FunctionFileSystemError({ cause }))),
  realPath: (pathname) =>
    fs.realPath(pathname).pipe(Effect.mapError((cause) => new FunctionFileSystemError({ cause }))),
  readDirectory: (pathname) =>
    fs
      .readDirectory(pathname)
      .pipe(Effect.mapError((cause) => new FunctionFileSystemError({ cause }))),
});

const resolveGitRoot = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  projectRoot: string,
): Effect.Effect<string, StackPreparationError> =>
  Effect.gen(function* () {
    let current = path.resolve(projectRoot);
    while (true) {
      const marker = path.join(current, ".git");
      const exists = yield* fs
        .exists(marker)
        .pipe(Effect.mapError((cause) => preparationError("Unable to inspect Git root", cause)));
      if (exists) return current;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(projectRoot);
      current = parent;
    }
  });

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
      const key = { stackId };
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

/** Removes the durable and runtime roots owned by one destroyed service instance. */
export const removeOwnedInstancePaths = (
  fileSystem: FileSystem.FileSystem,
  instancePaths: Pick<ServiceInstancePaths, "data" | "runtime">,
): Effect.Effect<void, StackCleanupError> =>
  Effect.forEach(
    [instancePaths.data, instancePaths.runtime],
    (ownedPath) =>
      fileSystem.remove(ownedPath, { recursive: true, force: true }).pipe(
        Effect.mapError(
          (error) =>
            new StackCleanupError({
              message: `Unable to remove destroyed instance path ${ownedPath}`,
              cause: error,
            }),
        ),
      ),
    { discard: true },
  );

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
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeContext = Context.add(
      options.context,
      ChildProcessSpawner.ChildProcessSpawner,
      childProcessSpawner,
    );
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
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* HttpClient.followRedirects(client, 20).get(url);
          if (response.status < 200 || response.status >= 300)
            return yield* preparationError(`HTTP ${response.status}`);
          return yield* response.json;
        }).pipe(
          Effect.mapError((cause) => preparationError("Unable to fetch Auth OIDC metadata", cause)),
          Effect.provide(NodeHttpClient.layerNodeHttp),
        ));
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
      options.bootstrapDatabase ??
      ((state: PersistedStackState) => {
        const instanceId = state.registry.defaultInstanceIds.database;
        const instance = state.registry.instances.find(
          (entry) => entry.id === instanceId && entry.service === "database",
        );
        return instance === undefined
          ? Effect.fail(
              new StackPreparationError({ message: "Default database instance is missing" }),
            )
          : bootstrapDatabaseAt(state, instance);
      });

    const artifacts = new Map<string, PreparedWorkloadArtifact>();
    const preparationStatuses = new Map<string, InstanceArtifactPreparationStatus>();
    const recordPreparationProgress = (
      progress: RuntimeArtifactPreparationProgress,
      workload: PlannedWorkload,
      artifactIdentity?: string,
    ): void => {
      preparationStatuses.set(progress.workloadId, {
        workloadId: progress.workloadId,
        instanceId: workload.instanceId,
        capability: progress.capability,
        state: progress.state,
        ...(artifactIdentity === undefined ? {} : { artifactIdentity }),
        ...(progress.error === undefined ? {} : { error: progress.error }),
      });
    };
    const queuePreparation = (workload: PlannedWorkload): void => {
      const cached = artifacts.get(artifactKey(state.runtime, workload));
      if (cached !== undefined) {
        recordPreparationProgress(
          { workloadId: workload.id, capability: workload.capability, state: "ready" },
          workload,
          cached.image ?? `${workload.recipeId}@${cached.version}`,
        );
        return;
      }
      const current = preparationStatuses.get(workload.id);
      if (current?.state === "preparing" || current?.state === "downloading") return;
      recordPreparationProgress(
        {
          workloadId: workload.id,
          capability: workload.capability,
          state: "queued",
        },
        workload,
      );
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
    const freshState = (key: Pick<RuntimeWorkloadKey, "stackId" | "instanceId" | "workloadId">) =>
      currentStateReader(options).pipe(
        Effect.mapError((error) => mapDriverError(key, error)),
        Effect.flatMap((fresh) =>
          runtimeMatches(fresh.runtime, state.runtime)
            ? Effect.succeed(fresh)
            : Effect.fail(driverError(key, "Persisted runtime changed while owner was active")),
        ),
      );
    const prepareOne = (runtime: StackRuntime, workload: PlannedWorkload) => {
      return Effect.suspend(() => {
        const key = artifactKey(runtime, workload);
        const cached = artifacts.get(key);
        return cached === undefined
          ? Effect.sync(() =>
              recordPreparationProgress(
                {
                  workloadId: workload.id,
                  capability: workload.capability,
                  state: "preparing",
                },
                workload,
              ),
            ).pipe(
              Effect.andThen(
                preparer.prepare(runtime, workload, (progress) =>
                  recordPreparationProgress(progress, workload),
                ),
              ),
              Effect.tap((prepared) =>
                Effect.sync(() => {
                  artifacts.set(key, prepared);
                  recordPreparationProgress(
                    {
                      workloadId: workload.id,
                      capability: workload.capability,
                      state: "ready",
                    },
                    workload,
                    prepared.image ?? `${workload.recipeId}@${prepared.version}`,
                  );
                }),
              ),
              Effect.tapError((error) =>
                Effect.sync(() =>
                  recordPreparationProgress(
                    {
                      workloadId: workload.id,
                      capability: workload.capability,
                      state: "failed",
                      error: error.message,
                    },
                    workload,
                  ),
                ),
              ),
            )
          : Effect.sync(() => {
              recordPreparationProgress(
                { workloadId: workload.id, capability: workload.capability, state: "ready" },
                workload,
                cached.image ?? `${workload.recipeId}@${cached.version}`,
              );
              return cached;
            });
      });
    };
    const prepare = (runtime: StackRuntime, workload: PlannedWorkload) =>
      Effect.gen(function* () {
        const key = artifactKey(runtime, workload);
        const joined = yield* Effect.uninterruptible(
          preparationGate.withPermit(
            Effect.gen(function* () {
              const existing = preparationInFlight.get(key);
              if (existing !== undefined) return existing;
              const scope = preparationScope ?? (preparationScope = yield* Scope.make("parallel"));
              let fiber: Fiber.Fiber<PreparedWorkloadArtifact, StackError> | undefined;
              const owner = prepareOne(runtime, workload).pipe(
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
        const prepared = yield* Fiber.join(joined).pipe(
          Effect.tapError((error) =>
            Effect.sync(() =>
              recordPreparationProgress(
                {
                  workloadId: workload.id,
                  capability: workload.capability,
                  state: "failed",
                  error: error.message,
                },
                workload,
              ),
            ),
          ),
        );
        yield* Effect.sync(() =>
          recordPreparationProgress(
            { workloadId: workload.id, capability: workload.capability, state: "ready" },
            workload,
            prepared.image ?? `${workload.recipeId}@${prepared.version}`,
          ),
        );
        return prepared;
      });
    const prepareArtifacts = (runtime: StackRuntime, workloads: ReadonlyArray<PlannedWorkload>) =>
      Effect.forEach(workloads, (workload) => prepare(runtime, workload), {
        concurrency: "unbounded",
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
        yield* prepareArtifacts(input.state.runtime, workloads);
      });
    const logPreparationFailure = (message: string): Effect.Effect<void> =>
      logs.append({ source: "supervisor", stream: "internal", message }).pipe(Effect.ignore);
    const prefetch = (persisted: PersistedStackState): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (persisted.preparation === "on-demand") return;
        const plan = yield* createExecutionPlan(persisted.runtime, persisted.registry).pipe(
          Effect.mapError((error) =>
            preparationError("Unable to plan background preparation", error),
          ),
        );
        const workloads = plan.workloads.filter(
          (workload) =>
            persisted.registry.instances.find(
              (instance) =>
                instance.id === workload.instanceId && instance.service === workload.capability,
            )?.config.activation === "lazy" &&
            !artifacts.has(artifactKey(persisted.runtime, workload)),
        );
        for (const workload of workloads) queuePreparation(workload);
        yield* Effect.forEach(
          workloads,
          (workload) =>
            prepare(persisted.runtime, workload).pipe(
              Effect.catch((error) =>
                logPreparationFailure(
                  `Background preparation failed for ${workload.id}: ${error.message}`,
                ),
              ),
            ),
          { concurrency: "unbounded", discard: true },
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
    const functionsPath = (
      instanceId: PlannedWorkload["instanceId"],
    ): Effect.Effect<string, StackPreparationError> =>
      serveTemplate.pipe(
        Effect.flatMap((content) => functionsBootstrap.write({ instanceId, content })),
      );
    const runtimeInputs = (
      workload: PlannedWorkload,
      fresh: PersistedStackState,
      host: ContainerHostRoute | undefined,
    ): Effect.Effect<WorkloadRuntimeInputs, StackPreparationError> =>
      Effect.gen(function* () {
        const material = yield* inputOwner.resolve(fresh, workload.instanceId, workload.id);
        const instancePaths = yield* resolveServiceInstancePaths(paths, workload.instanceId).pipe(
          Effect.provideService(Path.Path, pathService),
          Effect.mapError((cause) =>
            preparationError("Unable to resolve service instance runtime paths", cause),
          ),
        );
        const templates = material.auth?.templates;
        const apiListener = fresh.listeners.api;
        const apiAssignment = fresh.ports.find(
          (assignment) => assignment.owner === "stack" && assignment.binding === "api",
        );
        const templateBaseUrl =
          workload.recipeId !== "auth:auth" || templates === undefined || templates.length === 0
            ? undefined
            : apiListener?.enabled !== true || apiAssignment === undefined
              ? yield* preparationError(
                  "Configured Auth email templates require a public API listener",
                )
              : `http://${urlHost(host?.host ?? apiListener.address ?? "127.0.0.1")}:${apiAssignment.port}`;
        const auth =
          material.auth === undefined
            ? undefined
            : {
                ...material.auth,
                ...(templateBaseUrl === undefined ? {} : { templateBaseUrl }),
              };
        const functions =
          workload.recipeId === "functions:edge-runtime"
            ? {
                bootstrapPath: yield* functionsPath(workload.instanceId),
                files: yield* ((): Effect.Effect<FunctionFilesPlan, StackPreparationError> => {
                  const functionSettings = settingsForInstance(
                    fresh,
                    workload.instanceId,
                    "functions",
                  );
                  const root =
                    isRecord(functionSettings) && functionSettings.functions_root !== undefined
                      ? settingValue(fresh, functionSettings.functions_root)
                      : "";
                  if (root.length === 0)
                    return Effect.succeed({ files: [], warnings: [], allowedRoots: [] });
                  const projectRoot = fresh.identity.projectRoot;
                  const functionRoot = pathService.isAbsolute(root)
                    ? root
                    : pathService.resolve(projectRoot, root);
                  return Effect.gen(function* () {
                    const overrides = functionOverridesForSettings(fresh, workload.instanceId);
                    const functionFileSystem = makeFunctionFileSystem(fileSystem);
                    const resolved = yield* resolveFunctionConfigs({
                      root: functionRoot,
                      overrides,
                      fs: functionFileSystem,
                    });
                    const sourceRoot = yield* resolveGitRoot(fileSystem, pathService, projectRoot);
                    const additionalModuleRoots = resolved
                      .map(({ config }) => pathService.dirname(config.entrypointPath))
                      .filter((entrypointRoot, index, roots) => {
                        if (roots.indexOf(entrypointRoot) !== index) return false;
                        const relative = pathService.relative(sourceRoot, entrypointRoot);
                        return (
                          pathService.isAbsolute(relative) ||
                          relative === ".." ||
                          relative.startsWith(`..${pathService.sep}`)
                        );
                      });
                    const plans = yield* Effect.forEach(resolved, ({ config }) =>
                      planFunctionFiles({
                        projectRoot,
                        sourceRoot,
                        entrypoint: config.entrypointPath,
                        importMap: config.importMapPath,
                        staticFiles: config.staticFiles,
                        additionalModuleRoots,
                        skipMissingImportMapTargets: true,
                      }).pipe(
                        Effect.mapError((cause) =>
                          preparationError("Unable to plan Functions runtime files", cause),
                        ),
                      ),
                    );
                    const externalStaticFiles = yield* Effect.forEach(
                      resolved.flatMap(({ config }) =>
                        config.staticFiles.filter((pathname) => {
                          const relative = pathService.relative(sourceRoot, pathname);
                          return (
                            !/[*?[{]/u.test(relative) &&
                            (pathService.isAbsolute(relative) ||
                              relative === ".." ||
                              relative.startsWith(`..${pathService.sep}`))
                          );
                        }),
                      ),
                      (pathname) =>
                        functionFileSystem.lstat(pathname).pipe(
                          Effect.catchTag("FunctionFileSystemError", () => Effect.void),
                          Effect.map((info) =>
                            info?.isFile
                              ? {
                                  hostPath: pathname,
                                  targetPath: pathname,
                                  kind: "file" as const,
                                  externalScope: true,
                                }
                              : undefined,
                          ),
                        ),
                    );
                    const filesByTarget = new Map<string, FunctionFile>();
                    for (const file of [
                      ...plans.flatMap((plan) => plan.files),
                      ...externalStaticFiles,
                    ]) {
                      if (file !== undefined && !filesByTarget.has(file.targetPath))
                        filesByTarget.set(file.targetPath, file);
                    }
                    return {
                      files: [...filesByTarget.values()],
                      warnings: plans.flatMap((plan) => plan.warnings),
                      allowedRoots: [...new Set(plans.flatMap((plan) => plan.allowedRoots))],
                    };
                  }).pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.provideService(Path.Path, pathService),
                    Effect.mapError((cause) =>
                      cause instanceof StackPreparationError
                        ? cause
                        : preparationError("Unable to plan Functions runtime files", cause),
                    ),
                  );
                })(),
                ...(material.functions?.secrets === undefined
                  ? {}
                  : { secrets: material.functions.secrets }),
              }
            : undefined;
        return {
          ...(auth === undefined ? {} : { auth }),
          ...(workload.recipeId.startsWith("analytics:") && material.analytics !== undefined
            ? { analytics: material.analytics }
            : {}),
          database: { dataPath: instancePaths.postgresData },
          storage: { dataPath: pathService.join(instancePaths.data, "storage") },
          ...(functions === undefined ? {} : { functions }),
          ...(host === undefined ? {} : { hostRoute: host }),
        };
      });

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
        yield* validateDatabaseReadinessBudget(input.state, input.plan.workloads);
        const candidateState: PersistedStackState = input.state;
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
          const usableListeners = new Set(input.plan.routes.map(({ listener }) => listener));
          for (const assignment of input.state.ports) {
            if (assignment.owner !== "stack" || assignment.binding !== "api") continue;
            const listener = input.state.listeners.api;
            if (
              listener === undefined ||
              !usableListeners.has("api") ||
              listener.enabled !== true ||
              (listener.port === undefined
                ? assignment.intent !== "automatic"
                : listener.port !== assignment.port)
            )
              continue;
            yield* checkHostPort(listener.address ?? "127.0.0.1", assignment.port, "api").pipe(
              Effect.mapError(
                (error) =>
                  new PortUnavailableError({
                    field: "api",
                    port: assignment.port,
                    message: "Persisted api port is unavailable",
                    cause: error,
                  }),
              ),
            );
          }
          const requestedPrivate = new Set(
            privateBindingIntentsFor(input.plan, candidateState).map(privateBindingKey),
          );
          for (const assignment of input.state.privatePorts) {
            if (!requestedPrivate.has(privateBindingKey(assignment))) continue;
            yield* checkHostPort(
              "127.0.0.1",
              assignment.port,
              `${assignment.workloadId}:${assignment.binding}`,
            );
          }
          yield* Effect.forEach(
            input.plan.workloads.filter((workload) => workload.capability === "database"),
            (workload) =>
              resolveServiceInstancePaths(paths, workload.instanceId).pipe(
                Effect.provideService(Path.Path, pathService),
                Effect.mapError((error) =>
                  preparationError("Unable to resolve database runtime paths", error),
                ),
                Effect.flatMap((instancePaths) =>
                  checkNativeDatabaseLockEvidence(
                    fileSystem,
                    pathService.join(instancePaths.postgresData, "postmaster.pid"),
                  ),
                ),
              ),
          );
        }
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
          instanceId: workload.instanceId,
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
        Effect.mapError((error) =>
          driverError(key, `Readiness check failed for ${workload.id}: ${error.message}`, error),
        ),
      );
    const bootstrapWorkloadDatabase = (key: RuntimeWorkloadKey, workload: PlannedWorkload) =>
      workload.bootstrap === "database"
        ? freshState(key).pipe(
            Effect.flatMap((fresh) =>
              readinessDeadlineFor(fresh, workload).pipe(
                Effect.flatMap((deadline) =>
                  Effect.timeoutOrElse(
                    Effect.retry(
                      Effect.suspend(() => bootstrapDatabase(fresh)),
                      {
                        schedule: Schedule.spaced("100 millis"),
                        while: (error) =>
                          error instanceof DatabaseBootstrapError && error.retryable === true,
                      },
                    ),
                    {
                      duration: deadline,
                      orElse: () =>
                        Effect.fail(
                          new StackRuntimeError({
                            stackId: key.stackId,
                            workloadId: key.workloadId,
                            message: `Database bootstrap deadline exceeded for ${workload.id}`,
                          }),
                        ),
                    },
                  ),
                ),
              ),
            ),
            Effect.mapError((error) => mapDriverError(key, error)),
          )
        : Effect.void;
    const reconcileContainerDatabasePassword = (
      key: RuntimeWorkloadKey,
      workload: PlannedWorkload,
      resource: ContainerResource,
    ): Effect.Effect<void, RuntimeDriverError> => {
      if (containerEngine === undefined)
        return Effect.fail(driverError(key, "Container engine is unavailable"));
      return freshState(key).pipe(
        Effect.flatMap((fresh) =>
          Effect.all({
            deadline: readinessDeadlineFor(fresh, workload),
            plan: Effect.gen(function* () {
              const instance = fresh.registry.instances.find(
                (entry) => entry.id === key.instanceId,
              );
              return instance === undefined
                ? yield* driverError(key, "Database instance is missing from the registry")
                : yield* databaseBootstrapPlan(fresh, instance).pipe(
                    Effect.mapError((error) => mapDriverError(key, error)),
                  );
            }),
          }),
        ),
        Effect.flatMap(({ deadline, plan }) =>
          Effect.timeoutOrElse(
            Effect.gen(function* () {
              yield* Effect.retry(
                containerEngine.execContainer(resource.id, [
                  "pg_isready",
                  "--host=/tmp",
                  "--username=supabase_admin",
                  "--dbname=postgres",
                ]),
                {
                  schedule: Schedule.spaced("100 millis"),
                  while: (error) =>
                    error instanceof ContainerCommandError &&
                    (error.exitCode === 1 || error.exitCode === 2),
                },
              );
              yield* containerEngine.execContainer(
                resource.id,
                [
                  "psql",
                  "--host=/tmp",
                  "--username=supabase_admin",
                  "--dbname=postgres",
                  "--no-psqlrc",
                  "--set",
                  "ON_ERROR_STOP=1",
                ],
                `SET standard_conforming_strings = on;\nALTER ROLE supabase_admin PASSWORD '${Redacted.value(plan.databasePassword).replaceAll("'", "''")}';\n`,
              );
            }),
            {
              duration: deadline,
              orElse: () =>
                Effect.fail(
                  driverError(
                    key,
                    `Database socket readiness deadline exceeded for ${workload.id}`,
                  ),
                ),
            },
          ),
        ),
        Effect.mapError((error) => mapDriverError(key, error)),
      );
    };

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
                      timeout: startup.timeout ?? Duration.minutes(5),
                      env: { ...environment, ...startup.env },
                    })),
                  main: { ...resolvedNativeProcess, env: environment },
                };
              }),
            ),
          ),
        waitForReadiness,
        // PostgreSQL reconciliation is owned by PostgresInstanceRuntime so it can use the
        // admitted instance's private endpoint rather than the stack default.
        bootstrapDatabase: (key, workload) =>
          workload.capability === "database"
            ? Effect.void
            : bootstrapWorkloadDatabase(key, workload),
        logStore: logs,
        knownSecrets: Ref.get(knownSecrets).pipe(Effect.map((values) => [...values])),
        wipeDatabaseData: (key) =>
          Effect.gen(function* () {
            const instancePaths = yield* resolveServiceInstancePaths(paths, key.instanceId).pipe(
              Effect.provideService(Path.Path, pathService),
              Effect.mapError((error) =>
                driverError(key, "Unable to resolve native database data path", error),
              ),
            );
            const dataPath = instancePaths.postgresData;
            yield* fileSystem
              .remove(dataPath, { recursive: true, force: true })
              .pipe(
                Effect.mapError((error) =>
                  driverError(key, "Unable to wipe native database data", error),
                ),
              );
            yield* fileSystem
              .remove(instancePaths.manifest, { force: true })
              .pipe(
                Effect.mapError((error) =>
                  driverError(key, "Unable to remove native database manifest", error),
                ),
              );
          }),
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
                yield* prepare(fresh.runtime, workload).pipe(
                  Effect.mapError((error) => mapDriverError(key, error)),
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
                    instanceId: workload.instanceId,
                    workloadId: workload.id,
                    values: resolution.env,
                  })
                  .pipe(Effect.mapError((error) => mapDriverError(key, error)));
                const volume =
                  workload.recipeId === "database:database"
                    ? { target: "/var/lib/postgresql/data", readOnly: false }
                    : workload.recipeId === "storage:storage"
                      ? {
                          target: "/mnt",
                          readOnly: false,
                          ownerWorkloadId: "storage:storage",
                        }
                      : workload.recipeId === "storage:imgproxy"
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
        bootstrapDatabase: (key, workload, resource) =>
          workload.capability === "database"
            ? reconcileContainerDatabasePassword(key, workload, resource)
            : bootstrapWorkloadDatabase(key, workload),
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
    const instanceWorkloads = (input: InstanceRuntimeInput): ReadonlyArray<PlannedWorkload> =>
      input.plan.workloads.filter((workload) => workload.instanceId === input.instance.id);
    const instanceFailure = (input: InstanceRuntimeInput, error: unknown): StackError =>
      isStackError(error)
        ? error
        : new StackRuntimeError({
            stackId: input.stackId,
            message: error instanceof Error ? error.message : "Instance runtime operation failed",
            cause: error,
          });
    const instanceCleanupFailure = (
      input: InstanceRuntimeInput,
      error: unknown,
    ): StackCleanupError =>
      error instanceof StackCleanupError
        ? error
        : new StackCleanupError({
            message:
              error instanceof Error ? error.message : "Unable to clean up instance runtime data",
            cause: error,
          });
    const endpointForBinding = (
      input: InstanceRuntimeInput,
      workload: PlannedWorkload,
      binding: string,
    ): BackendEndpoint | undefined => {
      const assignment = input.state.privatePorts.find(
        (entry) =>
          entry.instanceId === input.instance.id &&
          entry.workloadId === workload.id &&
          entry.binding === binding,
      );
      return assignment === undefined ? undefined : { host: "127.0.0.1", port: assignment.port };
    };
    const publicationsFor = (
      input: InstanceRuntimeInput,
      workload: PlannedWorkload,
    ): ReadonlyArray<RuntimeBindingPublication> =>
      input.state.privatePorts
        .filter(
          (entry) => entry.instanceId === input.instance.id && entry.workloadId === workload.id,
        )
        .flatMap((entry) => {
          const endpoint = endpointForBinding(input, workload, entry.binding);
          return endpoint === undefined
            ? []
            : [
                {
                  workloadId: workload.id,
                  recipeId: workload.recipeId,
                  binding: entry.binding,
                  endpoint,
                } satisfies RuntimeBindingPublication,
              ];
        });
    const startWorkloads = (
      input: InstanceRuntimeInput,
    ): Effect.Effect<ReadonlyArray<RuntimeBindingPublication>, StackError> =>
      Effect.gen(function* () {
        const publications: RuntimeBindingPublication[] = [];
        for (const workload of instanceWorkloads(input)) {
          yield* prepare(input.state.runtime, workload);
          const startupPublications = publicationsFor(input, workload).filter(
            (publication) => publication.binding === "inspector",
          );
          const startOptions: RuntimeStartOptions =
            input.publishStartupBindings === undefined || startupPublications.length === 0
              ? {}
              : {
                  onStarted: Effect.forEach(startupPublications, (publication) =>
                    readinessDeadlineFor(input.state, workload).pipe(
                      Effect.flatMap((deadline) =>
                        probeInspectorReadiness(
                          {
                            mode: "http",
                            host: publication.endpoint.host,
                            port: publication.endpoint.port,
                            path: "/json/list",
                          },
                          deadline,
                        ),
                      ),
                    ),
                  ).pipe(
                    Effect.andThen(input.publishStartupBindings(startupPublications)),
                    Effect.mapError((error) =>
                      driverError(
                        {
                          stackId: input.stackId,
                          instanceId: input.instance.id,
                          workloadId: workload.id,
                        },
                        "Unable to publish startup bindings",
                        error,
                      ),
                    ),
                  ),
                };
          yield* baseDriver.start(
            { stackId: input.stackId, instanceId: input.instance.id, workloadId: workload.id },
            workload,
            startOptions,
          );
          publications.push(...publicationsFor(input, workload));
        }
        return publications;
      }).pipe(Effect.mapError((error) => instanceFailure(input, error)));
    const stopWorkloads = (input: InstanceRuntimeInput): Effect.Effect<void, StackError> =>
      Effect.forEach([...instanceWorkloads(input)].reverse(), (workload) =>
        baseDriver.stop({
          stackId: input.stackId,
          instanceId: input.instance.id,
          workloadId: workload.id,
        }),
      ).pipe(
        Effect.asVoid,
        Effect.mapError((error) => instanceFailure(input, error)),
      );
    const destroyWorkloads = (input: InstanceRuntimeInput): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        for (const workload of [...instanceWorkloads(input)].reverse()) {
          const key = {
            stackId: input.stackId,
            instanceId: input.instance.id,
            workloadId: workload.id,
          } satisfies RuntimeWorkloadKey;
          yield* baseDriver.stop(key);
          yield* baseDriver.remove(key);
          yield* baseDriver.wipePersistentData(key);
        }
      }).pipe(Effect.mapError((error) => instanceFailure(input, error)));
    const instancePrepare = (
      input: InstanceRuntimeInput,
    ): Effect.Effect<PrepareResult, StackError> =>
      Effect.gen(function* () {
        const prepared = yield* Effect.forEach(instanceWorkloads(input), (workload) =>
          prepare(input.state.runtime, workload),
        );
        return {
          instances: [
            {
              id: input.instance.id,
              service: input.instance.service,
              artifacts: prepared.map((artifact) => ({
                identity:
                  artifact.image ??
                  `${input.plan.workloads.find((workload) => workload.id === artifact.workloadId)?.recipeId ?? artifact.workloadId}@${artifact.version}`,
                outcome: artifact.outcome,
              })),
            },
          ],
        } satisfies PrepareResult;
      }).pipe(Effect.mapError((error) => instanceFailure(input, error)));
    const journalInstance = (
      input: InstanceRuntimeInput,
      phase: "admitted" | "running" | "settling" | "cleanup" | "complete",
      patch?: Readonly<{
        readonly stagingPath?: string;
        readonly outputPath?: string;
        readonly helperId?: string;
      }>,
    ): Effect.Effect<void, StackError> =>
      options.stateStore
        .update(options.stackId, (current) => {
          const instance = current.registry.instances.find(
            (entry) => entry.id === input.instance.id,
          );
          if (
            instance === undefined ||
            instance.pendingOperation?.id !== input.operation.id ||
            instance.pendingOperation.generation !== input.operation.generation
          )
            return Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: `Instance operation ${input.operation.id} is no longer current`,
              }),
            );
          const pendingOperation = {
            ...instance.pendingOperation,
            phase,
            ...(patch?.stagingPath === undefined ? {} : { stagingPath: patch.stagingPath }),
            ...(patch?.outputPath === undefined ? {} : { outputPath: patch.outputPath }),
            ...(patch?.helperId === undefined ? {} : { helperId: patch.helperId }),
          };
          return Effect.succeed({
            ...current,
            registry: {
              ...current.registry,
              instances: current.registry.instances.map((entry) =>
                entry.id === input.instance.id ? { ...entry, pendingOperation } : entry,
              ),
            },
          });
        })
        .pipe(
          Effect.provideContext(options.context),
          Effect.asVoid,
          Effect.mapError((error) =>
            error instanceof StackLifecycleConflictError
              ? error
              : new StackStateInvalidError({
                  stackId: options.stackId,
                  message: "Unable to journal instance runtime operation",
                  cause: error,
                }),
          ),
        );
    const publishData = (
      input: InstanceRuntimeInput,
      data: PersistedServiceInstance["data"],
      shouldPublish: (instance: PersistedServiceInstance) => boolean = () => true,
    ): Effect.Effect<void, StackError> =>
      options.stateStore
        .update(options.stackId, (current) => {
          const instance = current.registry.instances.find(
            (entry) => entry.id === input.instance.id,
          );
          if (
            instance === undefined ||
            instance.pendingOperation?.id !== input.operation.id ||
            instance.pendingOperation.generation !== input.operation.generation
          )
            return Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: `Instance operation ${input.operation.id} is no longer current`,
              }),
            );
          return Effect.succeed({
            ...current,
            registry: {
              ...current.registry,
              instances: current.registry.instances.map((entry) =>
                entry.id === input.instance.id && shouldPublish(entry) ? { ...entry, data } : entry,
              ),
            },
          });
        })
        .pipe(Effect.provideContext(options.context), Effect.asVoid);
    const defaultCatalogReconcile = (
      input: InstanceRuntimeInput,
      recipe: CatalogInitializationRecipe,
      endpoint: BackendEndpoint,
    ): Effect.Effect<CatalogInitializationResult, StackError> =>
      Effect.scoped(
        Effect.gen(function* () {
          // Catalog recipes are required even when their service instance is disabled. In that
          // case the execution plan has no long-lived workload, so materialize the one-shot
          // recipe against this database instance while retaining its catalog artifact identity.
          const workload =
            input.plan.workloads.find(
              (entry) =>
                entry.instanceId === input.instance.id &&
                entry.recipeId.startsWith(`${recipe.service}:`),
            ) ??
            (() => {
              const release = CAPABILITY_MODULES[recipe.service].releases[recipe.version];
              const entry = release?.workloads.find(
                (candidate) => candidate.capability === recipe.service,
              );
              if (entry === undefined) return undefined;
              const selected =
                input.state.runtime.kind === "native"
                  ? entry.artifacts.native
                  : entry.artifacts.container;
              return {
                id: `${input.instance.id}:catalog:${recipe.service}:${entry.name}`,
                instanceId: input.instance.id,
                recipeId: `${recipe.service}:${entry.name}`,
                capability: entry.capability,
                ...(entry.bootstrap === undefined ? {} : { bootstrap: entry.bootstrap }),
                dependencies: [],
                readiness: entry.readiness,
                artifacts: entry.artifacts,
                selected,
              } satisfies PlannedWorkload;
            })();
          if (workload === undefined)
            return yield* new StackPreparationError({
              message: `Catalog workload is missing for ${recipe.service}`,
              workload: input.instance.id,
            });
          const spec = runtimeSpecFor(workload);
          if (spec === undefined)
            return yield* new StackPreparationError({
              message: `Runtime specification is missing for ${workload.recipeId}`,
              workload: workload.id,
            });
          const route = yield* Ref.get(hostRoute);
          const inputs = {
            ...(yield* runtimeInputs(workload, input.state, route)),
            catalog: { capability: recipe.service, settings: recipe.settings },
          } satisfies WorkloadRuntimeInputs;
          yield* validateWorkloadRuntimeInputs(input.state, workload, inputs);
          const artifact = yield* prepare(input.state.runtime, workload);
          const databaseInstance =
            input.instance.service === "database" ? input.instance : undefined;
          const passwordSlot = databaseInstance?.config.passwordSecretRef;
          if (passwordSlot === undefined)
            return yield* new StackPreparationError({
              message:
                "Database instance password secret is unavailable for catalog initialization",
              workload: input.instance.id,
            });
          const password = input.state.secrets[passwordSlot]?.value;
          if (password === undefined || password.length === 0)
            return yield* new StackPreparationError({
              message: "Database instance password is unavailable for catalog initialization",
              workload: input.instance.id,
            });
          const target =
            input.state.runtime.kind === "container"
              ? {
                  host: `${catalogEntryFor("database:database").containerAlias}-${input.instance.id}`,
                  port: 5432,
                }
              : endpoint;
          const environment = rewriteCatalogDatabaseEnvironment(
            spec.env(input.state, workload, spec.containerPort, input.state.runtime.kind, inputs),
            { ...target, password },
          );
          const key = {
            stackId: input.stackId,
            instanceId: input.instance.id,
            workloadId: workload.id,
          } satisfies RuntimeWorkloadKey;
          if (input.state.runtime.kind === "native") {
            if (artifact.artifactRoot === undefined)
              return yield* new StackPreparationError({
                message: "Native catalog artifact root is unavailable",
                workload: workload.id,
              });
            const startups = spec.nativeStartupProcesses(
              artifact.artifactRoot,
              input.state,
              workload,
              endpoint.port,
              inputs,
            );
            if (startups.length === 0)
              return yield* new StackPreparationError({
                message: `Catalog workload has no initialization process for ${recipe.service}`,
                workload: workload.id,
              });
            yield* Effect.forEach(
              startups,
              (startup) =>
                runCatalogNativeProcess(
                  {
                    ...startup,
                    env: { ...startup.env, ...environment },
                    timeout: "5 minutes",
                  },
                  key,
                  stateSecrets(input.state),
                ),
              { discard: true },
            );
          } else {
            if (containerEngine === undefined)
              return yield* new StackPreparationError({
                message: "Container engine is unavailable for catalog initialization",
                workload: workload.id,
              });
            const network = (yield* containerEngine.listResources(input.stackId)).find(
              (resource) => resource.kind === "network",
            );
            if (network === undefined)
              return yield* new StackPreparationError({
                message: "Stack network is unavailable for catalog initialization",
                workload: workload.id,
              });
            if (artifact.image === undefined)
              return yield* new StackPreparationError({
                message: "Container catalog artifact image is unavailable",
                workload: workload.id,
              });
            const initWorkloadId = `${workload.id}:init:${input.operation.id}`;
            const startups = spec.containerStartupProcesses(input.state, workload, inputs);
            if (startups.length === 0)
              return yield* new StackPreparationError({
                message: `Catalog workload has no initialization process for ${recipe.service}`,
                workload: workload.id,
              });
            const image = artifact.image;
            yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const startup = Effect.gen(function* () {
                  const envFile = yield* envFiles.write({
                    instanceId: input.instance.id,
                    workloadId: initWorkloadId,
                    values: environment,
                  });
                  yield* Effect.forEach(
                    startups,
                    (process) =>
                      runContainerStartupProcess({
                        engine: containerEngine,
                        key,
                        timeout: "5 minutes",
                        specification: {
                          name: catalogInitContainerName(
                            key,
                            `${input.operation.id}-${recipe.recipeId}`,
                          ),
                          image,
                          labels: {
                            stackId: input.stackId,
                            ownerSessionId: options.ownerSessionId,
                            instanceId: input.instance.id,
                            workloadId: workload.id,
                            recipeId: workload.recipeId,
                            role: "workload",
                            startup: true,
                          },
                          network: network.id,
                          mounts: spec.containerMounts?.(input.state, workload, inputs) ?? [],
                          volumeMounts: [],
                          publications: [],
                          role: "workload",
                          entrypoint: process.entrypoint,
                          command: process.command,
                          envFile,
                        },
                      }),
                    { discard: true },
                  );
                });
                const startupResult = yield* Effect.exit(restore(startup));
                const cleanupResult = yield* Effect.exit(
                  envFiles.cleanupFile({
                    instanceId: input.instance.id,
                    workloadId: initWorkloadId,
                  }),
                );
                if (Exit.isFailure(startupResult) && Exit.isFailure(cleanupResult))
                  return yield* Effect.failCause(
                    Cause.combine(startupResult.cause, cleanupResult.cause),
                  );
                if (Exit.isFailure(startupResult))
                  return yield* Effect.failCause(startupResult.cause);
                if (Exit.isFailure(cleanupResult))
                  return yield* Effect.failCause(cleanupResult.cause);
              }),
            );
          }
          return {
            artifactIdentity: artifact.image ?? `${workload.recipeId}@${artifact.version}`,
          };
        }).pipe(
          Effect.mapError((error) => instanceFailure(input, error)),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        ),
      );
    const snapshotVolume = (input: InstanceRuntimeInput, workload: PlannedWorkload) => {
      if (containerEngine === undefined)
        return Effect.fail(
          new StackPreparationError({
            message: "Container engine is unavailable for PostgreSQL snapshot transfer",
            workload: input.instance.id,
          }),
        );
      const key = {
        stackId: input.stackId,
        instanceId: input.instance.id,
        workloadId: workload.id,
      } satisfies RuntimeWorkloadKey;
      const name = workloadVolumeName(key);
      const labels = {
        stackId: input.stackId,
        instanceId: input.instance.id,
        workloadId: workload.id,
        role: "volume",
      } satisfies ContainerVolumeLabels;
      return containerEngine.listResources(input.stackId).pipe(
        Effect.flatMap((resources) => {
          const volume = resources.find(
            (resource) =>
              resource.kind === "volume" &&
              resource.name === name &&
              resource.labels.role === "volume" &&
              resource.labels.instanceId === input.instance.id &&
              resource.labels.workloadId === workload.id,
          );
          return volume === undefined
            ? containerEngine.createVolume({ name, labels })
            : Effect.succeed(volume);
        }),
      );
    };
    const withSnapshotContainer = <A>(
      input: InstanceRuntimeInput,
      workload: PlannedWorkload,
      action: (containerId: string) => Effect.Effect<A, ContainerEngineFailure>,
      readOnly = false,
    ) => {
      if (containerEngine === undefined)
        return Effect.fail(
          new StackPreparationError({
            message: "Container engine is unavailable for PostgreSQL snapshot transfer",
            workload: input.instance.id,
          }),
        );
      const copyImage = prepare(input.state.runtime, workload).pipe(
        Effect.flatMap((artifact) =>
          artifact.image === undefined
            ? Effect.fail(
                new StackPreparationError({
                  message: "PostgreSQL snapshot helper image is unavailable",
                  workload: workload.id,
                }),
              )
            : Effect.succeed(artifact.image),
        ),
      );
      const key = {
        stackId: input.stackId,
        instanceId: input.instance.id,
        workloadId: workload.id,
      } satisfies RuntimeWorkloadKey;
      const volume = workloadVolumeName(key);
      return Effect.gen(function* () {
        const image = yield* copyImage;
        return yield* Effect.acquireUseRelease(
          containerEngine.createContainer({
            name: `${volume}-snapshot-${input.operation.id}`.replace(/[^A-Za-z0-9_.-]/g, "-"),
            image,
            labels: {
              stackId: input.stackId,
              ownerSessionId: options.ownerSessionId,
              instanceId: input.instance.id,
              workloadId: workload.id,
              recipeId: workload.recipeId,
              role: "workload",
              startup: true,
            },
            network: "none",
            mounts: [],
            volumeMounts: [{ volume, target: "/var/lib/postgresql/data", readOnly }],
            publications: [],
            role: "workload",
            entrypoint: "/bin/sh",
            command: [
              "-c",
              readOnly
                ? "tail -f /dev/null"
                : "chmod 700 /var/lib/postgresql/data && tail -f /dev/null",
            ],
          }),
          (helper) =>
            containerEngine.startContainer(helper.id).pipe(Effect.andThen(action(helper.id))),
          (helper) =>
            Effect.gen(function* () {
              const stopped = yield* Effect.exit(containerEngine.stopContainer(helper.id));
              const removed = yield* Effect.exit(containerEngine.removeContainer(helper.id));
              if (Exit.isFailure(stopped) && Exit.isFailure(removed))
                return yield* new StackCleanupError({
                  message: "Unable to stop and remove PostgreSQL snapshot helper",
                  cause: Cause.combine(stopped.cause, removed.cause),
                });
              if (Exit.isFailure(stopped))
                return yield* new StackCleanupError({
                  message: "Unable to stop PostgreSQL snapshot helper",
                  cause: stopped.cause,
                });
              if (Exit.isFailure(removed))
                return yield* new StackCleanupError({
                  message: "Unable to remove PostgreSQL snapshot helper",
                  cause: removed.cause,
                });
            }),
        );
      });
    };
    const restoreContainerOwnership = (
      input: InstanceRuntimeInput,
      workload: PlannedWorkload,
    ): Effect.Effect<void, StackError> => {
      if (containerEngine === undefined)
        return Effect.fail(
          new StackPreparationError({
            message: "Container engine is unavailable for PostgreSQL snapshot ownership",
            workload: input.instance.id,
          }),
        );
      const key = {
        stackId: input.stackId,
        instanceId: input.instance.id,
        workloadId: workload.id,
      } satisfies RuntimeWorkloadKey;
      const volume = workloadVolumeName(key);
      return prepare(input.state.runtime, workload).pipe(
        Effect.flatMap((artifact): Effect.Effect<void, StackError> => {
          if (artifact.image === undefined)
            return Effect.fail(
              new StackPreparationError({
                message: "PostgreSQL snapshot helper image is unavailable",
                workload: workload.id,
              }),
            );
          return runContainerStartupProcess({
            engine: containerEngine,
            key,
            timeout: "5 minutes",
            specification: {
              name: `${volume}-ownership-${input.operation.id}`.replace(/[^A-Za-z0-9_.-]/g, "-"),
              image: artifact.image,
              labels: {
                stackId: input.stackId,
                ownerSessionId: options.ownerSessionId,
                instanceId: input.instance.id,
                workloadId: workload.id,
                recipeId: workload.recipeId,
                role: "workload",
                startup: true,
              },
              network: "none",
              mounts: [],
              volumeMounts: [{ volume, target: "/var/lib/postgresql/data", readOnly: false }],
              publications: [],
              role: "workload",
              entrypoint: "/bin/sh",
              command: [
                "-c",
                "chown -R postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data",
              ],
            },
          }).pipe(Effect.mapError((error) => instanceFailure(input, error)));
        }),
      );
    };
    const postgres = makePostgresInstanceRuntime({
      runtime: state.runtime,
      paths,
      driver: baseDriver,
      artifactPreparer: {
        prepare: (runtime, workload) =>
          prepare(runtime, workload).pipe(
            Effect.mapError(
              (error) =>
                new StackPreparationError({
                  message: error.message,
                  workload: workload.id,
                  cause: error,
                }),
            ),
          ),
      },
      context: runtimeContext,
      snapshotData: {
        exists: (input) =>
          state.runtime.kind === "native"
            ? resolveServiceInstancePaths(paths, input.instance.id).pipe(
                Effect.provideService(Path.Path, pathService),
                Effect.flatMap((instancePaths) => fileSystem.exists(instancePaths.postgresData)),
                Effect.mapError((error) => instanceFailure(input, error)),
              )
            : Effect.gen(function* () {
                const workload = input.plan.workloads.find(
                  (entry) =>
                    entry.instanceId === input.instance.id && entry.capability === "database",
                );
                if (workload === undefined) return false;
                if (containerEngine === undefined) return false;
                const key = {
                  stackId: input.stackId,
                  instanceId: input.instance.id,
                  workloadId: workload.id,
                } satisfies RuntimeWorkloadKey;
                const name = workloadVolumeName(key);
                const resources = yield* containerEngine.listResources(input.stackId);
                return resources.some(
                  (resource) =>
                    resource.kind === "volume" &&
                    resource.name === name &&
                    resource.labels.role === "volume" &&
                    resource.labels.instanceId === input.instance.id &&
                    resource.labels.workloadId === workload.id,
                );
              }).pipe(Effect.mapError((error) => instanceFailure(input, error))),
        readVersion: (input) =>
          state.runtime.kind === "native"
            ? resolveServiceInstancePaths(paths, input.instance.id).pipe(
                Effect.provideService(Path.Path, pathService),
                Effect.flatMap((instancePaths) =>
                  fileSystem.readFileString(
                    pathService.join(instancePaths.postgresData, "PG_VERSION"),
                  ),
                ),
                Effect.flatMap((value) => {
                  const version = Number.parseInt(value.trim(), 10);
                  return Number.isSafeInteger(version) && version > 0
                    ? Effect.succeed(version)
                    : Effect.fail(
                        new StackPreparationError({
                          message: "PostgreSQL PG_VERSION is invalid",
                          workload: input.instance.id,
                        }),
                      );
                }),
                Effect.mapError((error) => instanceFailure(input, error)),
              )
            : Effect.gen(function* () {
                const workload = input.plan.workloads.find(
                  (entry) =>
                    entry.instanceId === input.instance.id && entry.capability === "database",
                );
                if (workload === undefined)
                  return yield* new StackPreparationError({
                    message: "Database workload is missing",
                    workload: input.instance.id,
                  });
                const copy = containerEngine?.copyFromContainer;
                if (copy === undefined)
                  return yield* new StackPreparationError({
                    message: "Container engine cannot read PostgreSQL PG_VERSION",
                    workload: input.instance.id,
                  });
                return yield* Effect.acquireUseRelease(
                  fileSystem.makeTempDirectory({
                    prefix: `supabase-pg-version-${input.instance.id}-`,
                  }),
                  (temporary) => {
                    const target = pathService.join(temporary, "PG_VERSION");
                    return withSnapshotContainer(
                      input,
                      workload,
                      (helperId) => copy(helperId, "/var/lib/postgresql/data/PG_VERSION", target),
                      true,
                    ).pipe(Effect.andThen(fileSystem.readFileString(target)));
                  },
                  (temporary) =>
                    fileSystem.remove(temporary, { recursive: true }).pipe(Effect.ignore),
                ).pipe(
                  Effect.flatMap((value) => {
                    const version = Number.parseInt(value.trim(), 10);
                    return Number.isSafeInteger(version) && version > 0
                      ? Effect.succeed(version)
                      : Effect.fail(
                          new StackPreparationError({
                            message: "PostgreSQL PG_VERSION is invalid",
                            workload: input.instance.id,
                          }),
                        );
                  }),
                );
              }).pipe(Effect.mapError((error) => instanceFailure(input, error))),
        restoreTargetEmpty: (input) =>
          state.runtime.kind === "native"
            ? resolveServiceInstancePaths(paths, input.instance.id).pipe(
                Effect.provideService(Path.Path, pathService),
                Effect.flatMap((instancePaths) =>
                  fileSystem
                    .exists(instancePaths.data)
                    .pipe(
                      Effect.flatMap((exists) =>
                        exists
                          ? fileSystem
                              .readDirectory(instancePaths.data)
                              .pipe(Effect.map((entries) => entries.length === 0))
                          : Effect.succeed(true),
                      ),
                    ),
                ),
                Effect.mapError((error) => instanceFailure(input, error)),
              )
            : Effect.gen(function* () {
                const workload = input.plan.workloads.find(
                  (entry) =>
                    entry.instanceId === input.instance.id && entry.capability === "database",
                );
                if (workload === undefined || containerEngine === undefined) return false;
                const key = {
                  stackId: input.stackId,
                  instanceId: input.instance.id,
                  workloadId: workload.id,
                } satisfies RuntimeWorkloadKey;
                const resources = yield* containerEngine.listResources(input.stackId);
                return !resources.some(
                  (resource) =>
                    resource.kind === "volume" && resource.name === workloadVolumeName(key),
                );
              }).pipe(Effect.mapError((error) => instanceFailure(input, error))),
        export: (input, destination) =>
          Effect.gen(function* () {
            const instancePaths = yield* resolveServiceInstancePaths(paths, input.instance.id).pipe(
              Effect.provideService(Path.Path, pathService),
            );
            if (state.runtime.kind === "native") {
              yield* fileSystem.copy(instancePaths.postgresData, destination, { overwrite: false });
              return;
            }
            const copy = containerEngine?.copyFromContainer;
            if (copy === undefined)
              return yield* new StackPreparationError({
                message: "Container engine does not support PostgreSQL volume export",
                workload: input.instance.id,
              });
            const workload = input.plan.workloads.find(
              (entry) => entry.instanceId === input.instance.id && entry.capability === "database",
            );
            if (workload === undefined)
              return yield* new StackPreparationError({ message: "Database workload is missing" });
            yield* withSnapshotContainer(input, workload, (helperId) =>
              copy(helperId, "/var/lib/postgresql/data/.", destination),
            );
          }).pipe(Effect.mapError((error) => instanceFailure(input, error))),
        restore: (input, source, destination) =>
          Effect.gen(function* () {
            if (state.runtime.kind === "container") {
              const engine = containerEngine;
              const copy = engine?.copyToContainer;
              const workload = input.plan.workloads.find(
                (entry) =>
                  entry.instanceId === input.instance.id && entry.capability === "database",
              );
              if (engine === undefined || copy === undefined || workload === undefined)
                return yield* new StackPreparationError({
                  message: "Container engine cannot restore PostgreSQL volume",
                  workload: input.instance.id,
                });
              const volume = yield* snapshotVolume(input, workload);
              const restored = yield* Effect.exit(
                Effect.gen(function* () {
                  yield* withSnapshotContainer(input, workload, (helperId) =>
                    copy(helperId, `${source}/.`, "/var/lib/postgresql/data/."),
                  );
                  yield* restoreContainerOwnership(input, workload);
                }),
              );
              if (Exit.isFailure(restored)) {
                const removed = yield* Effect.exit(engine.removeVolume(volume.id));
                if (Exit.isFailure(removed))
                  return yield* new StackCleanupError({
                    message: "Unable to remove PostgreSQL snapshot volume after restore failure",
                    cause: Cause.combine(restored.cause, removed.cause),
                  });
                return yield* Effect.failCause(restored.cause);
              }
              return;
            }
            const parent = pathService.dirname(destination);
            yield* fileSystem.makeDirectory(parent, { recursive: true });
            const temporary = `${destination}.restore-${input.operation.id}`;
            yield* Effect.acquireUseRelease(
              Effect.succeed(temporary),
              (staging) =>
                fileSystem
                  .copy(source, staging, { overwrite: false })
                  .pipe(Effect.andThen(fileSystem.rename(staging, destination))),
              (staging) =>
                fileSystem.remove(staging, { recursive: true }).pipe(
                  Effect.catchTag("PlatformError", (error) =>
                    Predicate.isTagged(error.reason, "NotFound")
                      ? Effect.void
                      : Effect.fail(
                          new StackCleanupError({
                            message: "Unable to clean up native PostgreSQL restore staging",
                            cause: error,
                          }),
                        ),
                  ),
                ),
            );
          }).pipe(Effect.mapError((error) => instanceFailure(input, error))),
        rollbackRestore: (input) =>
          state.runtime.kind === "native"
            ? resolveServiceInstancePaths(paths, input.instance.id).pipe(
                Effect.provideService(Path.Path, pathService),
                Effect.flatMap((instancePaths) =>
                  fileSystem
                    .remove(instancePaths.postgresData, { recursive: true })
                    .pipe(
                      Effect.catchTag("PlatformError", (error) =>
                        Predicate.isTagged(error.reason, "NotFound")
                          ? Effect.void
                          : Effect.fail(error),
                      ),
                    ),
                ),
                Effect.mapError((error) => instanceCleanupFailure(input, error)),
              )
            : Effect.gen(function* () {
                const workload = input.plan.workloads.find(
                  (entry) =>
                    entry.instanceId === input.instance.id && entry.capability === "database",
                );
                if (containerEngine === undefined || workload === undefined)
                  return yield* new StackPreparationError({
                    message: "Container engine cannot roll back PostgreSQL volume",
                    workload: input.instance.id,
                  });
                const resources = yield* containerEngine.listResources(input.stackId);
                const volume = resources.find(
                  (resource) =>
                    resource.kind === "volume" &&
                    resource.name ===
                      workloadVolumeName({
                        stackId: input.stackId,
                        instanceId: input.instance.id,
                        workloadId: workload.id,
                      }),
                );
                if (volume !== undefined) yield* containerEngine.removeVolume(volume.id);
              }).pipe(Effect.mapError((error) => instanceCleanupFailure(input, error))),
      },
      snapshotMetadata: (input, workload) =>
        prepare(input.state.runtime, workload).pipe(
          Effect.flatMap((artifact) =>
            input.state.runtime.kind === "container" && artifact.image === undefined
              ? Effect.fail(
                  new StackPreparationError({
                    message: "Container PostgreSQL artifact image is unavailable",
                    workload: workload.id,
                  }),
                )
              : Effect.succeed({
                  artifactIdentity:
                    input.state.runtime.kind === "container"
                      ? `container:${artifact.image}`
                      : `native:${artifact.version}`,
                  runtimeIdentity:
                    input.state.runtime.kind === "native"
                      ? `native:${workload.capability}:${input.instance.config.version}`
                      : `container:${workload.capability}:${input.instance.config.version}`,
                  majorVersion: Number.parseInt(
                    input.instance.config.version.match(/^(\d+)/u)?.[1] ?? "0",
                    10,
                  ),
                }),
          ),
          Effect.mapError((error) => instanceFailure(input, error)),
        ),
      reconcileManaged: (input, endpoint, workload) =>
        (options.bootstrapDatabase === undefined
          ? databaseBootstrapPlan(input.state, input.instance).pipe(
              Effect.flatMap((plan) =>
                readinessDeadlineFor(input.state, workload).pipe(
                  Effect.flatMap((deadline) =>
                    Effect.timeoutOrElse(
                      Effect.retry(
                        Effect.suspend(() =>
                          bootstrapManagedPostgres({
                            ...plan,
                            host: endpoint.host,
                            port: endpoint.port,
                          }),
                        ),
                        {
                          schedule: Schedule.spaced("100 millis"),
                          while: (error) =>
                            error instanceof DatabaseBootstrapError && error.retryable === true,
                        },
                      ),
                      {
                        duration: deadline,
                        orElse: () =>
                          Effect.fail(
                            new StackRuntimeError({
                              stackId: input.stackId,
                              workloadId: workload.id,
                              message: `Database credential reconciliation deadline exceeded for ${workload.id}`,
                            }),
                          ),
                      },
                    ),
                  ),
                ),
              ),
            )
          : options.bootstrapDatabase(input.state)
        ).pipe(Effect.mapError((error) => instanceFailure(input, error))),
      reconcileCatalogRecipe: (input, recipe, endpoint) => {
        return (
          options.reconcileCatalogRecipe?.(input, recipe, endpoint) ??
          defaultCatalogReconcile(input, recipe, endpoint)
        );
      },
      publishInitialization: (input, evidence) =>
        options.stateStore
          .update(options.stackId, (current) => {
            const instance = current.registry.instances.find(
              (entry) => entry.id === input.instance.id,
            );
            if (
              instance === undefined ||
              instance.pendingOperation?.id !== input.operation.id ||
              instance.pendingOperation.generation !== input.operation.generation
            )
              return Effect.fail(
                new StackLifecycleConflictError({
                  stackId: options.stackId,
                  message: `Instance operation ${input.operation.id} is no longer current`,
                }),
              );
            return Effect.succeed({
              ...current,
              registry: {
                ...current.registry,
                instances: current.registry.instances.map((entry) =>
                  entry.id === input.instance.id ? { ...entry, initialization: evidence } : entry,
                ),
              },
            });
          })
          .pipe(Effect.provideContext(options.context), Effect.asVoid),
      publishFreshData: (input, lineageId) =>
        publishData(
          input,
          { origin: "fresh", lineageId },
          (entry) => entry.data.origin === "absent" || entry.data.origin === "incomplete",
        ),
      publishIncompleteData: (input) =>
        publishData(input, { origin: "incomplete", operationId: input.operation.id }),
      publishAbsentData: (input) => publishData(input, { origin: "absent" }),
      journal: journalInstance,
    });
    const instanceStart = (input: InstanceRuntimeInput) =>
      input.instance.service === "database"
        ? postgres.start(input).pipe(Effect.mapError((error) => instanceFailure(input, error)))
        : startWorkloads(input);
    const instanceStop = (input: InstanceRuntimeInput) =>
      input.instance.service === "database" ? postgres.stop(input) : stopWorkloads(input);
    const instanceDestroy = (input: InstanceRuntimeInput) =>
      Effect.gen(function* () {
        const runtime =
          input.instance.service === "database" ? postgres.destroy(input) : destroyWorkloads(input);
        const runtimeResult = yield* Effect.exit(runtime);
        if (Exit.isFailure(runtimeResult)) return yield* Effect.failCause(runtimeResult.cause);
        const instancePaths = yield* resolveServiceInstancePaths(paths, input.instance.id).pipe(
          Effect.provideService(Path.Path, pathService),
          Effect.mapError(
            (error) =>
              new StackCleanupError({
                message: "Unable to resolve destroyed instance paths",
                cause: error,
              }),
          ),
        );
        yield* removeOwnedInstancePaths(fileSystem, instancePaths);
      });
    const unsupportedSnapshot = (input: InstanceRuntimeInput) =>
      Effect.fail(
        new UnsupportedSnapshotError({
          instanceId: input.instance.id,
          message: `Snapshots are unsupported for ${input.instance.service} instances`,
        }),
      );
    return {
      driver: baseDriver,
      preflight,
      prepare: instancePrepare,
      prepareArtifacts: prepareFor,
      start: instanceStart,
      stop: instanceStop,
      destroy: instanceDestroy,
      exportSnapshot: (input, snapshot) =>
        input.instance.service === "database"
          ? postgres.exportSnapshot(input, snapshot)
          : unsupportedSnapshot(input),
      restoreSnapshot: (input, snapshot) =>
        input.instance.service === "database"
          ? postgres.restoreSnapshot(input, snapshot)
          : unsupportedSnapshot(input),
      recoverSnapshot: (input, operation) =>
        input.instance.service === "database"
          ? postgres.recoverSnapshot(input, operation)
          : Effect.map(Effect.void, () => undefined),
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
