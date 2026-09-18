import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Scope,
  Semaphore,
  Stream,
  type Duration,
} from "effect";
import type { ContainerArtifact } from "../model/CapabilityModule.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { StackId } from "../public/StackId.ts";
import type { LogStore } from "../supervisor/LogStore.ts";
import {
  type ContainerContainerSpec,
  type ContainerEngine,
  type ContainerEngineFailure,
  type ContainerLabels,
  type ContainerMount,
  type ContainerStartupProcess,
  type ContainerVolumeMount,
  type ContainerVolumeLabels,
  type ContainerVolumeSpec,
  type ContainerResource,
  type ContainerResourceRole,
  type ContainerNetworkLabels,
  type ContainerWorkloadLabels,
  type ContainerLogOptions,
} from "./ContainerEngine.ts";
import {
  RuntimeDriverError,
  type RuntimeCleanupRequest,
  type ObservedWorkload,
  type RuntimeDriver,
  type RuntimeStartOptions,
  type RuntimeWorkloadKey,
} from "./RuntimeDriver.ts";
import { makeRuntimeCoordination } from "./RuntimeCoordination.ts";
import { ContainerEngineError } from "../public/Errors.ts";

export interface ContainerRuntimeOptions {
  readonly engine: ContainerEngine;
  readonly ownerSessionId: string;
  /** Maximum time allowed for each service-owned startup process. */
  readonly startupProcessTimeout?: Duration.Input;
  readonly resolveWorkload?: (
    key: RuntimeWorkloadKey,
    workload: PlannedWorkload,
  ) => Effect.Effect<ContainerWorkloadResolution, RuntimeDriverError>;
  /** Runs the one-shot initial database bootstrap after readiness. */
  readonly bootstrapDatabase?: (
    key: RuntimeWorkloadKey,
    workload: PlannedWorkload,
    resource: ContainerResource,
  ) => Effect.Effect<void, RuntimeDriverError>;
  /** Probes a newly-started workload before reporting it ready. */
  readonly waitForReadiness?: (
    key: RuntimeWorkloadKey,
    workload: PlannedWorkload,
    resource: ContainerResource,
  ) => Effect.Effect<void, RuntimeDriverError>;
  /** Updates container-to-host routing after the exact stack network is ready. */
  readonly onNetworkReady?: (
    network: ContainerResource,
  ) => Effect.Effect<boolean, RuntimeDriverError>;
  /** Persists exact container stdout/stderr lines while a workload is running. */
  readonly logStore?: LogStore;
}

export interface ContainerWorkloadResolution {
  /** Optional main-container entrypoint override (startup processes are explicit). */
  readonly entrypoint?: string;
  readonly mounts?: ReadonlyArray<ContainerMount>;
  readonly volume?: ContainerVolumeRequest;
  /** Path to an owned env file; secret bytes are kept out of engine argv. */
  readonly envFile?: string;
  readonly networkAliases?: ReadonlyArray<string>;
  /** Private host-loopback publications used by the in-process gateway. */
  readonly publications?: ReadonlyArray<ContainerPortPublicationInput>;
  /** Service-owned one-shot processes run before a newly-created main container. */
  readonly startup?: ReadonlyArray<ContainerStartupProcess>;
  readonly command?: ReadonlyArray<string>;
  /** Owner-created bootstrap copied into a newly-created container before start. */
  readonly bootstrap?: Readonly<{ readonly source: string; readonly destination: string }>;
  readonly waitForReadiness?: (
    key: RuntimeWorkloadKey,
    workload: PlannedWorkload,
    resource: ContainerResource,
  ) => Effect.Effect<void, RuntimeDriverError>;
}

/** Untrusted host-publication input validated before any engine operation. */
interface ContainerPortPublicationInput {
  readonly address: string;
  readonly hostPort: number;
  readonly containerPort: number;
}

interface ContainerVolumeRequest {
  readonly target: string;
  readonly readOnly: boolean;
  /** Stable logical workload that owns the persistent volume. Defaults to the mounting workload. */
  readonly ownerWorkloadId?: string;
}

interface ContainerRuntimeResource {
  readonly container: string;
  state: "starting" | "running" | "stopped" | "failed";
  readonly error?: string;
  readonly key: RuntimeWorkloadKey;
  readonly workload: PlannedWorkload;
  readonly failure: Deferred.Deferred<never, RuntimeDriverError>;
  readonly startOptions: RuntimeStartOptions;
  logFiber?: Fiber.Fiber<void, never>;
  watchFiber?: Fiber.Fiber<void, never>;
  stopRequested: boolean;
}

const resourceKey = (key: RuntimeWorkloadKey): string =>
  JSON.stringify([key.stackId, key.instanceId, key.workloadId]);

const nameFor = (key: RuntimeWorkloadKey, role: ContainerResourceRole): string =>
  role === "network"
    ? `supabase-${key.stackId.slice(0, 16)}-network`
    : `supabase-${key.stackId.slice(0, 16)}-${key.instanceId}-${key.workloadId.replace(/[^A-Za-z0-9_.-]/g, "-")}-${role}`;

/** Stable, engine-safe name for one operation-scoped catalog initialization container. */
export const catalogInitContainerName = (key: RuntimeWorkloadKey, operationId: string): string =>
  `supabase-${key.stackId.slice(0, 16)}-${key.instanceId}-${key.workloadId.replace(/[^A-Za-z0-9_.-]/g, "-")}-init-${operationId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;

const networkLabelsFor = (
  key: RuntimeWorkloadKey,
  ownerSessionId: string,
): ContainerNetworkLabels => ({
  stackId: key.stackId,
  ownerSessionId,
  role: "network",
});
const workloadLabelsFor = (
  key: RuntimeWorkloadKey,
  ownerSessionId: string,
  recipeId: string,
): ContainerWorkloadLabels => ({
  stackId: key.stackId,
  ownerSessionId,
  instanceId: key.instanceId,
  workloadId: key.workloadId,
  recipeId,
  role: "workload",
});
const startupLabelsFor = (
  key: RuntimeWorkloadKey,
  ownerSessionId: string,
  recipeId: string,
): ContainerWorkloadLabels => ({
  ...workloadLabelsFor(key, ownerSessionId, recipeId),
  startup: true,
});
const volumeOwnerFor = (key: RuntimeWorkloadKey, request: ContainerVolumeRequest): string =>
  request.ownerWorkloadId ?? key.workloadId;
const volumeLabelsFor = (
  key: RuntimeWorkloadKey,
  request: ContainerVolumeRequest,
): ContainerVolumeLabels => ({
  stackId: key.stackId,
  instanceId: key.instanceId,
  workloadId: volumeOwnerFor(key, request),
  role: "volume",
});
const volumeNameFor = (key: RuntimeWorkloadKey, ownerWorkloadId: string): string =>
  `supabase-${key.stackId}-${key.instanceId}-${ownerWorkloadId.replace(/[^A-Za-z0-9_.-]/g, "-")}-volume`;
export const workloadVolumeName = (key: RuntimeWorkloadKey): string =>
  volumeNameFor(key, key.workloadId);
const volumeSpecFor = (
  key: RuntimeWorkloadKey,
  request: ContainerVolumeRequest,
): ContainerVolumeSpec => ({
  name: volumeNameFor(key, volumeOwnerFor(key, request)),
  labels: volumeLabelsFor(key, request),
});
const volumeMountFor = (
  key: RuntimeWorkloadKey,
  request: ContainerVolumeRequest,
): ContainerVolumeMount => ({
  volume: volumeNameFor(key, volumeOwnerFor(key, request)),
  target: request.target,
  readOnly: request.readOnly,
});

const sameLabels = (left: ContainerLabels, right: ContainerLabels): boolean =>
  left.role === right.role &&
  (left.role === "volume" && right.role === "volume"
    ? left.stackId === right.stackId &&
      left.instanceId === right.instanceId &&
      left.workloadId === right.workloadId
    : left.stackId === right.stackId &&
      "ownerSessionId" in left &&
      "ownerSessionId" in right &&
      left.ownerSessionId === right.ownerSessionId &&
      (left.role === "network" ||
        ("workloadId" in left && "workloadId" in right && left.workloadId === right.workloadId)));

/** Workload identity excludes ownerSessionId; stack ownership is fenced externally. */
const sameWorkloadIdentity = (left: ContainerLabels, right: ContainerWorkloadLabels): boolean =>
  left.role === "workload" &&
  left.stackId === right.stackId &&
  left.instanceId === right.instanceId &&
  left.workloadId === right.workloadId &&
  left.recipeId === right.recipeId &&
  left.startup !== true;

const sameWorkloadKey = (left: ContainerLabels, key: RuntimeWorkloadKey): boolean =>
  left.role === "workload" &&
  left.stackId === key.stackId &&
  left.instanceId === key.instanceId &&
  left.workloadId === key.workloadId &&
  left.startup !== true;

/** Networks are identified by stack identity. */
const sameNetworkIdentity = (left: ContainerLabels, right: ContainerNetworkLabels): boolean =>
  left.role === "network" &&
  left.stackId === right.stackId &&
  "ownerSessionId" in left &&
  left.ownerSessionId === right.ownerSessionId;

const toDriverError = (
  key: Pick<RuntimeWorkloadKey, "stackId"> &
    Partial<Pick<RuntimeWorkloadKey, "instanceId" | "workloadId">>,
  error: unknown,
): RuntimeDriverError =>
  new RuntimeDriverError({
    message: error instanceof Error ? error.message : String(error),
    stackId: key.stackId,
    ...(key.instanceId === undefined ? {} : { instanceId: key.instanceId }),
    ...(key.workloadId === undefined ? {} : { workloadId: key.workloadId }),
    cause: error,
  });

const toContainerEngineError = (
  engine: ContainerEngine["kind"],
  error: unknown,
): ContainerEngineError =>
  new ContainerEngineError({
    engine,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });

const runtimeCleanupError = (key: RuntimeWorkloadKey): RuntimeDriverError =>
  new RuntimeDriverError({
    message: "Container runtime cleanup is in progress",
    stackId: key.stackId,
    instanceId: key.instanceId,
    workloadId: key.workloadId,
  });
const failRuntimeCleanup = (key: RuntimeWorkloadKey): Effect.Effect<never, RuntimeDriverError> =>
  Effect.fail(runtimeCleanupError(key));

const withEngine = <A>(
  engine: ContainerEngine,
  key: Pick<RuntimeWorkloadKey, "stackId"> &
    Partial<Pick<RuntimeWorkloadKey, "instanceId" | "workloadId">>,
  effect: Effect.Effect<A, ContainerEngineFailure>,
): Effect.Effect<A, RuntimeDriverError> =>
  effect.pipe(
    Effect.mapError((error) => toDriverError(key, toContainerEngineError(engine.kind, error))),
  );

/** Runs one service-owned one-shot container: create, start, wait for exit 0, remove. */
export const runContainerStartupProcess = (input: {
  readonly engine: ContainerEngine;
  readonly key: RuntimeWorkloadKey;
  readonly specification: ContainerContainerSpec;
  readonly timeout: Duration.Input;
  readonly logStore?: LogStore;
  readonly capability?: PlannedWorkload["capability"];
  readonly runtimeScope?: Scope.Scope;
}): Effect.Effect<void, RuntimeDriverError> => {
  let logFiber: Fiber.Fiber<void, RuntimeDriverError> | undefined;
  const acquire = withEngine(
    input.engine,
    input.key,
    input.engine.createContainer(input.specification),
  );
  const use = (container: ContainerResource): Effect.Effect<void, RuntimeDriverError> =>
    Effect.gen(function* () {
      yield* withEngine(input.engine, input.key, input.engine.startContainer(container.id));
      const logStore = input.logStore;
      const runtimeScope = input.runtimeScope;
      const capability = input.capability;
      if (logStore !== undefined && runtimeScope !== undefined && capability !== undefined) {
        const consume = input.engine.streamLogs(container.id, { tail: "all" }).pipe(
          Stream.runForEach((line) =>
            logStore
              .append({
                source: capability,
                stream: line.stream,
                message: line.message,
              })
              .pipe(Effect.asVoid),
          ),
          Effect.mapError((error) =>
            toDriverError(input.key, toContainerEngineError(input.engine.kind, error)),
          ),
        );
        logFiber = yield* Effect.forkIn(consume, runtimeScope);
      }
      const exitCode = yield* withEngine(
        input.engine,
        input.key,
        input.engine.waitContainer(container.id),
      );
      const logs = logFiber === undefined ? Exit.succeed(undefined) : yield* Fiber.await(logFiber);
      const logFailure =
        Exit.isFailure(logs) && !Cause.hasInterruptsOnly(logs.cause) ? logs.cause : undefined;
      const exitFailure =
        exitCode === 0
          ? undefined
          : toDriverError(
              input.key,
              new Error(
                `Container startup process exited with code ${String(exitCode)} for ${input.key.workloadId}`,
              ),
            );
      if (exitFailure !== undefined) {
        const exitCause = Cause.fail(exitFailure);
        return yield* logFailure !== undefined
          ? Effect.failCause(Cause.combine(exitCause, logFailure))
          : Effect.failCause(exitCause);
      }
      if (logFailure !== undefined) return yield* Effect.failCause(logFailure);
    });
  const release = (
    container: ContainerResource,
    useExit: Exit.Exit<void, RuntimeDriverError>,
  ): Effect.Effect<void, RuntimeDriverError> =>
    Effect.gen(function* () {
      if (logFiber !== undefined) yield* Fiber.interrupt(logFiber);
      const removed = yield* Effect.exit(
        withEngine(input.engine, input.key, input.engine.removeContainer(container.id)),
      );
      if (Exit.isFailure(removed))
        return yield* Effect.failCause(
          Exit.isFailure(useExit) ? Cause.combine(useExit.cause, removed.cause) : removed.cause,
        );
    });
  return Effect.acquireUseRelease(acquire, use, release).pipe(
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () =>
        Effect.fail(
          toDriverError(
            input.key,
            new Error(`Container startup process timed out for ${input.key.workloadId}`),
          ),
        ),
    }),
  );
};

const containerArtifact = (workload: PlannedWorkload): ContainerArtifact | undefined =>
  workload.selected.kind === "container" ? workload.selected : undefined;

const isWorkloadResource = (
  entry: ContainerResource,
): entry is ContainerResource & { readonly labels: ContainerWorkloadLabels } =>
  entry.kind === "workload" && entry.labels.role === "workload";

/** Startup containers are marked by the startup label. */
const isStartupContainer = (entry: ContainerResource): boolean =>
  isWorkloadResource(entry) && entry.labels.startup === true;

const isNetworkResource = (
  entry: ContainerResource,
): entry is ContainerResource & { readonly labels: ContainerNetworkLabels } =>
  entry.kind === "network" && entry.labels.role === "network";

const isValidPublication = (
  publication: ContainerPortPublicationInput,
): publication is ContainerPortPublicationInput & { readonly address: "127.0.0.1" } =>
  publication.address === "127.0.0.1" &&
  Number.isInteger(publication.hostPort) &&
  Number.isInteger(publication.containerPort) &&
  publication.hostPort >= 1 &&
  publication.hostPort <= 65_535 &&
  publication.containerPort >= 1 &&
  publication.containerPort <= 65_535;

/** RuntimeDriver implementation backed by one exact, injected container engine. */
export const makeContainerRuntime = (
  options: ContainerRuntimeOptions,
): Effect.Effect<RuntimeDriver, never, Scope.Scope> =>
  Effect.gen(function* () {
    const startupProcessTimeout =
      options.startupProcessTimeout ?? ("5 minutes" satisfies Duration.Input);
    const parentScope = yield* Scope.Scope;
    const runtimeScope = yield* Scope.fork(parentScope, "parallel");
    const coordination = yield* makeRuntimeCoordination;
    // Serialize only exact shared-network (and volume identity) establishment. Resolution,
    // image pulls, startup migrations, container creation, and readiness run outside this gate.
    const setup = yield* Semaphore.make(1);
    const resources = new Map<string, ContainerRuntimeResource>();
    const startGuards = new Map<string, Ref.Ref<boolean>>();
    const startFibers = new Map<string, Fiber.Fiber<ObservedWorkload, RuntimeDriverError>>();

    const withEngine = <A>(
      key: Pick<RuntimeWorkloadKey, "stackId"> &
        Partial<Pick<RuntimeWorkloadKey, "instanceId" | "workloadId">>,
      effect: Effect.Effect<A, ContainerEngineFailure>,
    ): Effect.Effect<A, RuntimeDriverError> =>
      effect.pipe(
        Effect.mapError((error) =>
          toDriverError(key, toContainerEngineError(options.engine.kind, error)),
        ),
      );

    const stopLogs = (resource: ContainerRuntimeResource): Effect.Effect<void> =>
      resource.logFiber === undefined ? Effect.void : Fiber.interrupt(resource.logFiber);

    const stopExitWatcher = (resource: ContainerRuntimeResource): Effect.Effect<void> =>
      resource.watchFiber === undefined ? Effect.void : Fiber.interrupt(resource.watchFiber);

    const cleanupStartedContainer = (
      key: RuntimeWorkloadKey,
      containerId: string,
    ): Effect.Effect<void, RuntimeDriverError> =>
      coordination.withKey(
        key,
        Effect.uninterruptible(
          Effect.gen(function* () {
            const exact = (yield* withEngine(key, options.engine.listResources(key.stackId))).find(
              (entry) => entry.kind === "workload" && entry.id === containerId,
            );
            if (exact === undefined) return;
            if (exact.state === "running")
              yield* withEngine(key, options.engine.stopContainer(containerId));
            yield* withEngine(key, options.engine.removeContainer(containerId));
          }),
        ),
      );

    const cleanupRegisteredResource = (
      resource: ContainerRuntimeResource,
    ): Effect.Effect<void, RuntimeDriverError> =>
      Effect.gen(function* () {
        resource.stopRequested = true;
        yield* stopLogs(resource);
        yield* stopExitWatcher(resource);
        const cleanup = yield* cleanupStartedContainer(resource.key, resource.container).pipe(
          Effect.exit,
        );
        const id = resourceKey(resource.key);
        if (resources.get(id) === resource) resources.delete(id);
        if (Exit.isFailure(cleanup)) return yield* Effect.failCause(cleanup.cause);
      });

    const reportFailure = (
      resource: ContainerRuntimeResource,
      error: unknown,
      message = `Container workload failed for ${resource.key.workloadId}`,
    ): Effect.Effect<void> => {
      const current = resources.get(resourceKey(resource.key));
      if (resource.stopRequested || current !== resource || resource.state === "failed")
        return Effect.void;
      const failure =
        error instanceof RuntimeDriverError
          ? error
          : new RuntimeDriverError({
              message,
              stackId: resource.key.stackId,
              instanceId: resource.key.instanceId,
              workloadId: resource.key.workloadId,
              cause: error,
            });
      resources.set(resourceKey(resource.key), {
        ...resource,
        state: "failed",
        error: failure.message,
      });
      return Deferred.fail(resource.failure, failure).pipe(Effect.asVoid);
    };

    const attachLogs = (
      resource: ContainerRuntimeResource,
      tail: ContainerLogOptions["tail"],
    ): Effect.Effect<void> => {
      const logStore = options.logStore;
      if (logStore === undefined) return Effect.void;
      const stream = options.engine.streamLogs(resource.container, { tail });
      const consume = stream.pipe(
        Stream.runForEach((line) =>
          logStore
            .append({
              source: resource.workload.capability,
              stream: line.stream,
              message: line.message,
            })
            .pipe(Effect.asVoid),
        ),
        Effect.mapError((error) =>
          toDriverError(resource.key, toContainerEngineError(options.engine.kind, error)),
        ),
        Effect.catch((error) => reportFailure(resource, error)),
      );
      return Effect.gen(function* () {
        resource.logFiber = yield* Effect.forkIn(consume, runtimeScope);
        // Give the follower one scheduling turn so process acquisition begins before readiness.
        yield* Effect.yieldNow;
      });
    };

    const attachExitWatcher = (resource: ContainerRuntimeResource): Effect.Effect<void> => {
      if (resource.watchFiber !== undefined) return Effect.void;
      const wait = Effect.exit(
        withEngine(resource.key, options.engine.waitContainer(resource.container)),
      ).pipe(
        Effect.flatMap((result) =>
          resource.stopRequested
            ? Effect.void
            : reportFailure(
                resource,
                Exit.isFailure(result)
                  ? Option.getOrElse(
                      Cause.findErrorOption(result.cause),
                      () => new Error("Container wait failed"),
                    )
                  : new Error(`Container exited with code ${String(result.value)}`),
              ),
        ),
        Effect.ignore,
      );
      return Effect.forkIn(wait, runtimeScope).pipe(
        Effect.tap((fiber) =>
          Effect.sync(() => {
            resource.watchFiber = fiber;
          }),
        ),
        Effect.asVoid,
      );
    };

    const observe = (
      stackId: StackId,
    ): Effect.Effect<ReadonlyArray<ObservedWorkload>, RuntimeDriverError> =>
      withEngine({ stackId }, options.engine.listResources(stackId)).pipe(
        Effect.map((entries) =>
          entries
            .filter(isWorkloadResource)
            .filter((entry) => entry.labels.stackId === stackId)
            .filter((entry) => !isStartupContainer(entry))
            .map((entry) => {
              const key: RuntimeWorkloadKey = {
                stackId: entry.labels.stackId,
                instanceId: entry.labels.instanceId,
                workloadId: entry.labels.workloadId,
              };
              const local = resources.get(resourceKey(key));
              return {
                ...key,
                state:
                  local?.state === "failed"
                    ? "failed"
                    : local?.state === "starting"
                      ? "starting"
                      : entry.state === "running"
                        ? "ready"
                        : entry.state === "stopped"
                          ? "stopped"
                          : "starting",
                ...(local?.error === undefined ? {} : { error: local.error }),
              };
            }),
        ),
      );

    const runStartupProcess = (
      key: RuntimeWorkloadKey,
      workload: PlannedWorkload,
      startupProcess: ContainerStartupProcess,
      context: Readonly<{
        readonly artifact: ContainerArtifact;
        readonly network: ContainerResource;
        readonly resolution: ContainerWorkloadResolution;
        readonly volumeRequest?: ContainerVolumeRequest;
      }>,
    ): Effect.Effect<void, RuntimeDriverError> => {
      const labels = startupLabelsFor(key, options.ownerSessionId, workload.recipeId);
      return runContainerStartupProcess({
        engine: options.engine,
        key,
        timeout: startupProcessTimeout,
        specification: {
          // Reuse the main name so crash-orphaned init containers are exact collisions to clean up.
          name: nameFor(key, "workload"),
          image: context.artifact.image,
          labels,
          network: context.network.id,
          mounts: context.resolution.mounts ?? [],
          volumeMounts:
            context.volumeRequest === undefined ? [] : [volumeMountFor(key, context.volumeRequest)],
          publications: [],
          role: "workload",
          entrypoint: startupProcess.entrypoint,
          command: startupProcess.command,
          ...(context.resolution.envFile === undefined
            ? {}
            : { envFile: context.resolution.envFile }),
        },
        ...(options.logStore === undefined
          ? {}
          : {
              logStore: options.logStore,
              capability: workload.capability,
              runtimeScope,
            }),
      });
    };

    const start = (
      key: RuntimeWorkloadKey,
      workload: PlannedWorkload,
      startOptions: RuntimeStartOptions = {},
    ): Effect.Effect<ObservedWorkload, RuntimeDriverError> => {
      const artifact = containerArtifact(workload);
      if (artifact === undefined)
        return Effect.fail(
          new RuntimeDriverError({
            message: "Container runtime cannot start a native artifact",
            stackId: key.stackId,
            instanceId: key.instanceId,
            workloadId: key.workloadId,
          }),
        );

      const labels = workloadLabelsFor(key, options.ownerSessionId, workload.recipeId);
      const networkLabels = networkLabelsFor(key, options.ownerSessionId);
      const networkName = nameFor(key, "network");
      const resolved =
        options.resolveWorkload === undefined
          ? Effect.succeed<ContainerWorkloadResolution>({})
          : options.resolveWorkload(key, workload);
      const id = resourceKey(key);
      const guard = Effect.gen(function* () {
        const current = startGuards.get(id);
        if (current === undefined)
          return yield* toDriverError(
            key,
            new Error("Container workload start was not registered"),
          );
        const stopped = yield* Ref.get(current);
        if (stopped)
          return yield* toDriverError(key, new Error("Container workload start was stopped"));
      });
      const startEffect = Effect.gen(function* () {
        yield* guard;
        const existing = resources.get(resourceKey(key));
        if (existing !== undefined && existing.state === "running")
          return { ...key, state: "ready" } satisfies ObservedWorkload;
        const setupResult = yield* Effect.gen(function* () {
          if (existing !== undefined && existing.state !== "running") {
            existing.stopRequested = true;
            yield* stopLogs(existing);
            yield* stopExitWatcher(existing);
            if (existing.state === "failed")
              yield* withEngine(key, options.engine.stopContainer(existing.container));
            resources.delete(resourceKey(key));
          }
          const initialResolution = yield* resolved;
          yield* guard;
          const initialPublications = initialResolution.publications ?? [];
          if (initialPublications.some((publication) => !isValidPublication(publication)))
            return yield* toDriverError(
              key,
              new Error("Container publications must use valid loopback host ports"),
            );
          const initialVolumeRequest = initialResolution.volume;
          if (initialVolumeRequest !== undefined && initialVolumeRequest.target.length === 0)
            return yield* toDriverError(key, new Error("Container volume mapping is invalid"));
          yield* withEngine(key, options.engine.preflight);
          const entries = yield* withEngine(key, options.engine.listResources(key.stackId));
          const existingExact = entries.find(
            (entry) => entry.kind === "workload" && sameWorkloadIdentity(entry.labels, labels),
          );
          const namedCollision = entries.find(
            (entry) => entry.kind === "workload" && entry.name === nameFor(key, "workload"),
          );
          const collision =
            namedCollision !== undefined && isWorkloadResource(namedCollision)
              ? namedCollision
              : undefined;
          if (
            existingExact === undefined &&
            namedCollision !== undefined &&
            (collision === undefined ||
              collision.labels.stackId !== key.stackId ||
              collision.labels.instanceId !== key.instanceId ||
              collision.labels.workloadId !== key.workloadId ||
              collision.labels.role !== "workload" ||
              collision.labels.startup !== true)
          )
            return yield* toDriverError(
              key,
              new Error("Container name is owned by another workload"),
            );

          // A new owner never adopts a durable container. Remove any exact identity first;
          // lifecycle ownership has already fenced the stack before this activation.
          if (existingExact !== undefined) {
            if (existingExact.state === "running")
              yield* withEngine(key, options.engine.stopContainer(existingExact.id));
            yield* withEngine(key, options.engine.removeContainer(existingExact.id));
          }
          yield* withEngine(key, options.engine.inspectImage(artifact.image)).pipe(
            Effect.flatMap((inspected) =>
              inspected.present
                ? Effect.void
                : withEngine(key, options.engine.pullImage(artifact.image)),
            ),
          );
          yield* guard;

          const networkResource = yield* setup.withPermit(
            Effect.gen(function* () {
              const networkEntries = yield* withEngine(
                key,
                options.engine.listResources(key.stackId),
              );
              const exactNetwork = networkEntries
                .filter(isNetworkResource)
                .find((entry) => sameNetworkIdentity(entry.labels, networkLabels));
              const namedNetworkCollision = networkEntries.find(
                (entry) => entry.kind === "network" && entry.name === networkName,
              );
              const networkCollision =
                namedNetworkCollision !== undefined && isNetworkResource(namedNetworkCollision)
                  ? namedNetworkCollision
                  : undefined;
              if (
                exactNetwork === undefined &&
                namedNetworkCollision !== undefined &&
                (networkCollision === undefined || networkCollision.labels.stackId !== key.stackId)
              )
                return yield* toDriverError(
                  key,
                  new Error("Container network name is owned by another stack"),
                );
              if (exactNetwork === undefined && networkCollision !== undefined)
                yield* withEngine(key, options.engine.removeNetwork(networkCollision.id));
              return (
                exactNetwork ??
                (yield* withEngine(
                  key,
                  options.engine.createNetwork({ name: networkName, labels: networkLabels }),
                ))
              );
            }),
          );

          if (options.onNetworkReady !== undefined) yield* options.onNetworkReady(networkResource);
          // Resolve after the shared network is established so every concurrent caller observes
          // the final host route, including callers whose initial preflight raced this setup.
          const resolution =
            options.resolveWorkload === undefined
              ? yield* Effect.succeed<ContainerWorkloadResolution>({})
              : yield* options.resolveWorkload(key, workload);
          yield* guard;
          const requestedPublications = resolution.publications ?? [];
          if (requestedPublications.some((publication) => !isValidPublication(publication)))
            return yield* toDriverError(
              key,
              new Error("Container publications must use valid loopback host ports"),
            );
          const publications = requestedPublications.filter(isValidPublication);
          const volumeRequest = resolution.volume;
          if (volumeRequest !== undefined && volumeRequest.target.length === 0)
            return yield* toDriverError(key, new Error("Container volume mapping is invalid"));
          const volumeSpec =
            volumeRequest === undefined ? undefined : volumeSpecFor(key, volumeRequest);
          if (volumeSpec !== undefined) {
            const volume = volumeSpec;
            yield* setup.withPermit(
              Effect.gen(function* () {
                const volumeEntries = yield* withEngine(
                  key,
                  options.engine.listResources(key.stackId),
                );
                const exactVolume = volumeEntries.find(
                  (entry) =>
                    entry.kind === "volume" &&
                    entry.name === volume.name &&
                    sameLabels(entry.labels, volume.labels),
                );
                if (exactVolume !== undefined) return;
                const sameLabel = volumeEntries.find(
                  (entry) => entry.kind === "volume" && sameLabels(entry.labels, volume.labels),
                );
                const sameName = volumeEntries.find(
                  (entry) => entry.kind === "volume" && entry.name === volume.name,
                );
                if (sameLabel !== undefined || sameName !== undefined)
                  return yield* toDriverError(
                    key,
                    new Error("Container volume identity collision"),
                  );
                yield* withEngine(key, options.engine.createVolume(volume));
              }),
            );
          }

          if (collision !== undefined && collision.id !== existingExact?.id) {
            if (collision.state === "running")
              yield* withEngine(key, options.engine.stopContainer(collision.id));
            yield* withEngine(key, options.engine.removeContainer(collision.id));
          }

          for (const startup of resolution.startup ?? [])
            yield* runStartupProcess(key, workload, startup, {
              artifact,
              network: networkResource,
              resolution,
              ...(volumeRequest === undefined ? {} : { volumeRequest }),
            });
          yield* guard;

          const container = yield* withEngine(
            key,
            options.engine.createContainer({
              name: nameFor(key, "workload"),
              image: artifact.image,
              labels,
              network: networkResource.id,
              mounts: resolution.mounts ?? [],
              publications,
              volumeMounts: volumeRequest === undefined ? [] : [volumeMountFor(key, volumeRequest)],
              role: "workload",
              ...(resolution.envFile === undefined ? {} : { envFile: resolution.envFile }),
              ...(resolution.networkAliases === undefined
                ? {}
                : { networkAliases: resolution.networkAliases }),
              ...(resolution.entrypoint === undefined ? {} : { entrypoint: resolution.entrypoint }),
              ...(resolution.command === undefined ? {} : { command: resolution.command }),
            } satisfies ContainerContainerSpec),
          );
          if (resolution.bootstrap !== undefined) {
            const copied = yield* Effect.exit(
              withEngine(
                key,
                options.engine.copyToContainer(
                  container.id,
                  resolution.bootstrap.source,
                  resolution.bootstrap.destination,
                ),
              ),
            );
            if (Exit.isFailure(copied)) {
              const removed = yield* Effect.exit(
                withEngine(key, options.engine.removeContainer(container.id)),
              );
              const cleanupCause = Exit.isFailure(removed) ? removed.cause : Cause.empty;
              return yield* Effect.failCause(
                cleanupCause.reasons.length === 0
                  ? copied.cause
                  : Cause.combine(copied.cause, cleanupCause),
              );
            }
          }
          yield* guard;
          yield* withEngine(key, options.engine.startContainer(container.id));
          const registered = yield* Effect.uninterruptibleMask((restore) =>
            restore(
              Effect.gen(function* () {
                yield* guard;
                const failure = yield* Deferred.make<never, RuntimeDriverError>();
                yield* guard;
                const createdResource: ContainerRuntimeResource = {
                  key,
                  workload,
                  container: container.id,
                  state: "starting",
                  failure,
                  startOptions,
                  stopRequested: false,
                };
                return createdResource;
              }).pipe(
                Effect.flatMap((createdResource) =>
                  coordination.withKeyCommit(
                    key,
                    Effect.sync(() => {
                      resources.set(resourceKey(key), createdResource);
                      return createdResource;
                    }),
                  ),
                ),
                Effect.flatMap((committed) =>
                  Option.isNone(committed)
                    ? Effect.fail(
                        new RuntimeDriverError({
                          message: "Container runtime cleanup is in progress",
                          stackId: key.stackId,
                          instanceId: key.instanceId,
                          workloadId: key.workloadId,
                        }),
                      )
                    : Effect.succeed(committed.value),
                ),
              ),
            ).pipe(Effect.exit),
          );
          if (Exit.isFailure(registered)) {
            const cleanup = yield* cleanupStartedContainer(key, container.id).pipe(Effect.exit);
            return yield* Effect.failCause(
              Exit.isFailure(cleanup)
                ? Cause.combine(registered.cause, cleanup.cause)
                : registered.cause,
            );
          }
          return { resource: registered.value, resolution, container };
        });
        const { resource, resolution, container } = setupResult;
        const postRegistration = Effect.gen(function* () {
          yield* attachLogs(resource, "all");
          yield* attachExitWatcher(resource);
          if (resource.startOptions.onStarted !== undefined) yield* resource.startOptions.onStarted;
          const readiness =
            resolution.waitForReadiness === undefined
              ? options.waitForReadiness === undefined
                ? Effect.void
                : options.waitForReadiness(key, workload, container)
              : resolution.waitForReadiness(key, workload, container);
          yield* Effect.raceFirst(readiness, Deferred.await(resource.failure));
          if (workload.bootstrap === "database") {
            if (options.bootstrapDatabase === undefined)
              return yield* toDriverError(
                key,
                new Error("Database bootstrap resolver is not configured"),
              );
            yield* options.bootstrapDatabase(key, workload, container);
          }
          resource.state = "running";
          return { ...key, state: "ready" } satisfies ObservedWorkload;
        });
        // The mask lets Exit observe ordinary failures from the restored work; interruptions stay
        // pending and re-raise at mask exit, where the outer wrapper performs cleanup.
        const completed = yield* Effect.uninterruptibleMask((restore) =>
          restore(postRegistration).pipe(Effect.exit),
        );
        if (Exit.isFailure(completed)) {
          const cleanup = yield* cleanupRegisteredResource(resource).pipe(Effect.exit);
          return yield* Effect.failCause(
            Exit.isFailure(cleanup)
              ? Cause.combine(completed.cause, cleanup.cause)
              : completed.cause,
          );
        }
        return completed.value;
      });
      const admission = coordination.withKeyCommit(
        key,
        Effect.gen(function* () {
          const inFlight = startFibers.get(id);
          if (inFlight !== undefined) return { kind: "join" as const, fiber: inFlight };
          const existing = resources.get(id);
          if (existing?.state === "running")
            return {
              kind: "ready" as const,
              value: { ...key, state: "ready" } satisfies ObservedWorkload,
            };
          const guardRef = yield* Ref.make(false);
          startGuards.set(id, guardRef);
          // Track the whole registration wait so cleanup can interrupt starts queued behind
          // another activation; readiness and log following continue after this short section.
          const run: Effect.Effect<ObservedWorkload, RuntimeDriverError> = Effect.gen(function* () {
            const body = yield* coordination.withKeyCommit(
              key,
              Effect.forkChild(startEffect, { startImmediately: true }),
            );
            if (Option.isNone(body)) return yield* failRuntimeCleanup(key);
            return yield* Fiber.join(body.value);
          });
          const fiber = yield* Effect.forkChild(run, { startImmediately: true });
          startFibers.set(id, fiber);
          return { kind: "start" as const, fiber, guardRef };
        }),
      );
      return Effect.flatMap(
        admission,
        (admitted): Effect.Effect<ObservedWorkload, RuntimeDriverError> => {
          if (Option.isNone(admitted)) return failRuntimeCleanup(key);
          if (admitted.value.kind === "ready") return Effect.succeed(admitted.value.value);
          const { fiber } = admitted.value;
          if (admitted.value.kind === "join") return Fiber.join(fiber);
          return Effect.uninterruptibleMask<ObservedWorkload, RuntimeDriverError, never>(
            (restore) =>
              Effect.gen(function* () {
                const joined = yield* restore(Fiber.join(fiber)).pipe(Effect.exit);
                if (Exit.isFailure(joined)) {
                  yield* Fiber.interrupt(fiber);
                  const resource = resources.get(id);
                  if (resource !== undefined) {
                    const cleanup = yield* cleanupRegisteredResource(resource).pipe(Effect.exit);
                    if (Exit.isFailure(cleanup))
                      return yield* Effect.failCause(Cause.combine(joined.cause, cleanup.cause));
                  }
                  return yield* Effect.failCause(joined.cause);
                }
                return joined.value;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (startGuards.get(id) === admitted.value.guardRef) startGuards.delete(id);
                    if (startFibers.get(id) === fiber) startFibers.delete(id);
                  }),
                ),
              ),
          );
        },
      );
    };

    const stopInPermit = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> => {
      const found = resources.get(resourceKey(key));
      const guard = startGuards.get(resourceKey(key));
      return found !== undefined
        ? found.state === "stopped"
          ? Effect.void
          : Effect.gen(function* () {
              found.stopRequested = true;
              if (guard !== undefined) yield* Ref.set(guard, true);
              yield* Deferred.fail(
                found.failure,
                new RuntimeDriverError({
                  message: "Container workload was stopped while starting",
                  stackId: key.stackId,
                  instanceId: key.instanceId,
                  workloadId: key.workloadId,
                }),
              );
              yield* stopLogs(found);
              yield* stopExitWatcher(found);
              yield* withEngine(key, options.engine.stopContainer(found.container));
              const id = resourceKey(key);
              if (resources.get(id) === found) resources.set(id, { ...found, state: "stopped" });
            })
        : (guard === undefined ? Effect.void : Ref.set(guard, true)).pipe(
            Effect.andThen(withEngine(key, options.engine.listResources(key.stackId))),
            Effect.flatMap((entries) => {
              const exact = entries
                .filter(isWorkloadResource)
                .find((entry) => sameWorkloadKey(entry.labels, key));
              return exact === undefined
                ? Effect.void
                : exact.state === "running"
                  ? withEngine(key, options.engine.stopContainer(exact.id))
                  : Effect.void;
            }),
          );
    };

    const stop = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> =>
      coordination.withKey(
        key,
        Effect.suspend(() => stopInPermit(key)),
      );

    const remove = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> =>
      coordination.withKey(
        key,
        Effect.gen(function* () {
          const found = resources.get(resourceKey(key));
          if (found !== undefined) {
            found.stopRequested = true;
            const guard = startGuards.get(resourceKey(key));
            if (guard !== undefined) yield* Ref.set(guard, true);
            yield* Deferred.fail(
              found.failure,
              new RuntimeDriverError({
                message: "Container workload was removed while starting",
                stackId: key.stackId,
                instanceId: key.instanceId,
                workloadId: key.workloadId,
              }),
            );
            yield* stopLogs(found);
            yield* stopExitWatcher(found);
            if (found.state !== "stopped")
              yield* withEngine(key, options.engine.stopContainer(found.container));
            yield* withEngine(key, options.engine.removeContainer(found.container));
            resources.delete(resourceKey(key));
            return;
          }
          const guard = startGuards.get(resourceKey(key));
          if (guard !== undefined) yield* Ref.set(guard, true);
          const entries = yield* withEngine(key, options.engine.listResources(key.stackId));
          const exact = entries
            .filter(isWorkloadResource)
            .find((entry) => sameWorkloadKey(entry.labels, key));
          if (exact === undefined) return;
          if (exact.state === "running")
            yield* withEngine(key, options.engine.stopContainer(exact.id));
          yield* withEngine(key, options.engine.removeContainer(exact.id));
        }),
      );

    const cleanup = (request: RuntimeCleanupRequest): Effect.Effect<void, RuntimeDriverError> =>
      coordination.withStackCleanup(
        request.stackId,
        Effect.gen(function* () {
          // Stop and interrupt starts that have not registered a resource yet. Without this
          // fence, cleanup can observe an empty resource list while an activation is still inside
          // createContainer, then the activation creates a new orphan after cleanup returns.
          const pendingStartIds = new Set(
            [...startGuards.keys(), ...startFibers.keys()].filter((id) =>
              id.startsWith(`["${request.stackId}",`),
            ),
          );
          for (const id of pendingStartIds) {
            const guard = startGuards.get(id);
            if (guard !== undefined) yield* Ref.set(guard, true);
          }
          for (const id of pendingStartIds) {
            const fiber = startFibers.get(id);
            if (fiber !== undefined) yield* Fiber.interrupt(fiber);
          }

          const entries = yield* withEngine(
            { stackId: request.stackId },
            options.engine.listResources(request.stackId),
          );
          const owned = entries
            .filter((entry) => entry.labels.stackId === request.stackId)
            .sort((left, right) => left.id.localeCompare(right.id));
          let cleanupCause: Cause.Cause<RuntimeDriverError> = Cause.empty;
          const attempt = <A>(effect: Effect.Effect<A, RuntimeDriverError>) =>
            Effect.gen(function* () {
              const result = yield* Effect.exit(effect);
              if (Exit.isFailure(result)) cleanupCause = Cause.combine(cleanupCause, result.cause);
            });

          for (const resource of resources.values())
            if (resource.key.stackId === request.stackId) {
              resource.stopRequested = true;
              yield* stopLogs(resource);
              yield* stopExitWatcher(resource);
            }

          // Stop and remove every stack workload before touching its network. A failed
          // stop does not prevent the remove attempt; all failures are returned together.
          for (const entry of owned.filter(isWorkloadResource)) {
            const workloadKey = {
              stackId: request.stackId,
              instanceId: entry.labels.instanceId,
              workloadId: entry.labels.workloadId,
            } satisfies RuntimeWorkloadKey;
            yield* attempt(
              coordination.withKey(
                workloadKey,
                Effect.gen(function* () {
                  if (entry.state === "running")
                    yield* withEngine(workloadKey, options.engine.stopContainer(entry.id));
                  yield* withEngine(workloadKey, options.engine.removeContainer(entry.id));
                }),
              ),
            );
          }
          for (const entry of owned.filter(isNetworkResource))
            yield* attempt(
              withEngine({ stackId: request.stackId }, options.engine.removeNetwork(entry.id)),
            );
          if (request.destroy)
            for (const entry of owned.filter((candidate) => candidate.kind === "volume"))
              yield* attempt(
                withEngine({ stackId: request.stackId }, options.engine.removeVolume(entry.id)),
              );

          for (const id of resources.keys())
            if (id.startsWith(`["${request.stackId}",`)) resources.delete(id);
          if (cleanupCause.reasons.length > 0) return yield* Effect.failCause(cleanupCause);
        }),
      );

    const wipePersistentData = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> =>
      coordination.withKey(
        key,
        Effect.gen(function* () {
          const entries = yield* withEngine(key, options.engine.listResources(key.stackId));
          const volumes = entries.filter(
            (entry) =>
              entry.kind === "volume" &&
              entry.labels.role === "volume" &&
              entry.labels.instanceId === key.instanceId &&
              entry.labels.workloadId === key.workloadId,
          );
          for (const volume of volumes)
            yield* withEngine(key, options.engine.removeVolume(volume.id));
        }),
      );

    return {
      observe,
      start,
      stop,
      remove,
      cleanup,
      wipePersistentData,
    } satisfies RuntimeDriver;
  });
