import { Cause, Deferred, Effect, Exit, Fiber, Option, Scope, Semaphore, Stream } from "effect";
import type { ContainerArtifact } from "../model/CapabilityModule.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { StackId } from "../public/StackId.ts";
import type { LogStore } from "../supervisor/LogStore.ts";
import {
  type ContainerContainerSpec,
  type ContainerHostRoute,
  type ContainerEngine,
  type ContainerEngineFailure,
  type ContainerLabels,
  type ContainerMount,
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
  type RuntimeRecoveryRequest,
  type ObservedWorkload,
  type RuntimeDriver,
  type RuntimeWorkloadKey,
} from "./RuntimeDriver.ts";

export interface ContainerRuntimeOptions {
  readonly engine: ContainerEngine;
  readonly ownerSessionId: string;
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
  /** Probes an adopted or newly-started workload before reporting it ready. */
  readonly waitForReadiness?: (
    key: RuntimeWorkloadKey,
    workload: PlannedWorkload,
    resource: ContainerResource,
  ) => Effect.Effect<void, RuntimeDriverError>;
  /** Persists exact container stdout/stderr lines while a workload is running. */
  readonly logStore?: LogStore;
}

export interface ContainerWorkloadResolution {
  readonly mounts?: ReadonlyArray<ContainerMount>;
  readonly volume?: ContainerVolumeRequest;
  /** Path to an owned env file; secret bytes are kept out of engine argv. */
  readonly envFile?: string;
  readonly networkAliases?: ReadonlyArray<string>;
  readonly hostRoute?: ContainerHostRoute;
  /** Private host-loopback publications used by the in-process gateway. */
  readonly publications?: ReadonlyArray<ContainerPortPublicationInput>;
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

interface ContainerRuntimeResourceIds {
  readonly container: string;
  readonly network: string;
  readonly state: "running" | "stopped" | "failed";
  readonly error?: string;
}

interface ContainerRuntimeResource extends ContainerRuntimeResourceIds {
  readonly key: RuntimeWorkloadKey;
  readonly workload: PlannedWorkload;
  readonly failure: Deferred.Deferred<never, RuntimeDriverError>;
  logFiber?: Fiber.Fiber<void, never>;
  stopRequested: boolean;
}

const resourceKey = (key: RuntimeWorkloadKey): string =>
  `${key.stackId}:${key.desiredGeneration}:${key.workloadId}:${key.specHash}`;

const nameFor = (key: RuntimeWorkloadKey, role: ContainerResourceRole): string =>
  role === "network"
    ? `supabase-${key.stackId.slice(0, 16)}-${key.desiredGeneration}-network`
    : `supabase-${key.stackId.slice(0, 16)}-${key.desiredGeneration}-${key.workloadId.replace(/[^A-Za-z0-9_.-]/g, "-")}-${role}`;

const networkLabelsFor = (
  key: RuntimeWorkloadKey,
  ownerSessionId: string,
): ContainerNetworkLabels => ({
  stackId: key.stackId,
  ownerSessionId,
  desiredGeneration: key.desiredGeneration,
  role: "network",
});
const workloadLabelsFor = (
  key: RuntimeWorkloadKey,
  ownerSessionId: string,
): ContainerWorkloadLabels => ({
  stackId: key.stackId,
  ownerSessionId,
  desiredGeneration: key.desiredGeneration,
  workloadId: key.workloadId,
  specHash: key.specHash,
  role: "workload",
});
const volumeOwnerFor = (key: RuntimeWorkloadKey, request: ContainerVolumeRequest): string =>
  request.ownerWorkloadId ?? key.workloadId;
const volumeLabelsFor = (
  key: RuntimeWorkloadKey,
  request: ContainerVolumeRequest,
): ContainerVolumeLabels => ({
  stackId: key.stackId,
  workloadId: volumeOwnerFor(key, request),
  role: "volume",
});
const volumeNameFor = (key: RuntimeWorkloadKey, ownerWorkloadId: string): string =>
  `supabase-${key.stackId}-${ownerWorkloadId.replace(/[^A-Za-z0-9_.-]/g, "-")}-volume`;
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
    ? left.stackId === right.stackId && left.workloadId === right.workloadId
    : left.stackId === right.stackId &&
      "ownerSessionId" in left &&
      "ownerSessionId" in right &&
      left.ownerSessionId === right.ownerSessionId &&
      left.desiredGeneration === right.desiredGeneration &&
      (left.role === "network" ||
        ("workloadId" in left &&
          "workloadId" in right &&
          left.workloadId === right.workloadId &&
          "specHash" in left &&
          "specHash" in right &&
          left.specHash === right.specHash)));

/** Recovery identity deliberately excludes ownerSessionId. The ownership lock fences adoption. */
const sameWorkloadIdentity = (left: ContainerLabels, right: ContainerWorkloadLabels): boolean =>
  left.role === "workload" &&
  left.stackId === right.stackId &&
  left.desiredGeneration === right.desiredGeneration &&
  left.workloadId === right.workloadId &&
  left.specHash === right.specHash;

/** Networks are adopted by stack and desired generation, never by old owner session. */
const sameNetworkIdentity = (left: ContainerLabels, right: ContainerNetworkLabels): boolean =>
  left.role === "network" &&
  left.stackId === right.stackId &&
  left.desiredGeneration === right.desiredGeneration;

const toDriverError = (
  key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">,
  error: unknown,
): RuntimeDriverError =>
  new RuntimeDriverError({
    message: error instanceof Error ? error.message : String(error),
    stackId: key.stackId,
    workloadId: key.workloadId,
    cause: error,
  });

const containerArtifact = (workload: PlannedWorkload): ContainerArtifact | undefined =>
  workload.selected.kind === "container" ? workload.selected : undefined;

const isWorkloadResource = (
  entry: ContainerResource,
): entry is ContainerResource & { readonly labels: ContainerWorkloadLabels } =>
  entry.kind === "workload" && entry.labels.role === "workload";

const isManagedContainer = (
  entry: ContainerResource,
): entry is ContainerResource & { readonly labels: ContainerWorkloadLabels } =>
  entry.kind === "workload" && entry.labels.role === "workload";

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
): Effect.Effect<RuntimeDriver, never> =>
  Effect.gen(function* () {
    const parentScope = yield* Effect.serviceOption(Scope.Scope);
    const runtimeScope = Option.isSome(parentScope)
      ? yield* Scope.fork(parentScope.value, "parallel")
      : yield* Scope.make("parallel");
    const lifecycle = yield* Semaphore.make(1);
    const resources = new Map<string, ContainerRuntimeResource>();

    const withEngine = <A>(
      key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">,
      effect: Effect.Effect<A, ContainerEngineFailure>,
    ): Effect.Effect<A, RuntimeDriverError> =>
      effect.pipe(Effect.mapError((error) => toDriverError(key, error)));

    const stopLogs = (resource: ContainerRuntimeResource): Effect.Effect<void> =>
      resource.logFiber === undefined ? Effect.void : Fiber.interrupt(resource.logFiber);

    const reportLogFailure = (
      resource: ContainerRuntimeResource,
      error: unknown,
    ): Effect.Effect<void> => {
      if (resource.stopRequested) return Effect.void;
      const failure = new RuntimeDriverError({
        message: `Container log stream failed for ${resource.key.workloadId}`,
        stackId: resource.key.stackId,
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
      if (options.engine.streamLogs === undefined)
        return reportLogFailure(resource, new Error("Container log streaming is unavailable"));
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
        Effect.mapError((error) => toDriverError(resource.key, error)),
        Effect.catch((error) => reportLogFailure(resource, error)),
      );
      return Effect.gen(function* () {
        resource.logFiber = yield* Effect.forkIn(consume, runtimeScope);
        // Give the follower one scheduling turn so process acquisition begins before readiness.
        yield* Effect.yieldNow;
      });
    };

    const observe = (
      stackId: StackId,
    ): Effect.Effect<ReadonlyArray<ObservedWorkload>, RuntimeDriverError> =>
      withEngine({ stackId, workloadId: "" }, options.engine.listResources(stackId)).pipe(
        Effect.map((entries) =>
          entries
            .filter(isWorkloadResource)
            .filter((entry) => entry.labels.stackId === stackId)
            .map((entry) => {
              const key: RuntimeWorkloadKey = {
                stackId: entry.labels.stackId,
                desiredGeneration: entry.labels.desiredGeneration,
                workloadId: entry.labels.workloadId,
                specHash: entry.labels.specHash,
              };
              const local = resources.get(resourceKey(key));
              return {
                ...key,
                state:
                  local?.state === "failed"
                    ? "failed"
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

    const start = (
      key: RuntimeWorkloadKey,
      workload: PlannedWorkload,
    ): Effect.Effect<ObservedWorkload, RuntimeDriverError> => {
      const artifact = containerArtifact(workload);
      if (artifact === undefined)
        return Effect.fail(
          new RuntimeDriverError({
            message: "Container runtime cannot start a native artifact",
            stackId: key.stackId,
            workloadId: key.workloadId,
          }),
        );

      const labels = workloadLabelsFor(key, options.ownerSessionId);
      const networkLabels = networkLabelsFor(key, options.ownerSessionId);
      const networkName = nameFor(key, "network");
      const resolved =
        options.resolveWorkload === undefined
          ? Effect.succeed<ContainerWorkloadResolution>({})
          : options.resolveWorkload(key, workload);
      const startEffect = Effect.gen(function* () {
        const existing = resources.get(resourceKey(key));
        if (existing !== undefined && existing.state !== "running") {
          existing.stopRequested = true;
          yield* stopLogs(existing);
          if (existing.state === "failed")
            yield* withEngine(key, options.engine.stopContainer(existing.container));
          resources.delete(resourceKey(key));
        }
        const resolution = yield* resolved;
        const requestedPublications = resolution.publications ?? [];
        if (requestedPublications.some((publication) => !isValidPublication(publication)))
          return yield* toDriverError(
            key,
            new Error("Container publications must use valid loopback host ports"),
          );
        const publications = requestedPublications.filter(isValidPublication);
        yield* withEngine(key, options.engine.preflight);
        const volumeRequest = resolution.volume;
        if (volumeRequest !== undefined && volumeRequest.target.length === 0)
          return yield* toDriverError(key, new Error("Container volume mapping is invalid"));
        const entries = yield* withEngine(key, options.engine.listResources(key.stackId));
        const volumeSpec =
          volumeRequest === undefined ? undefined : volumeSpecFor(key, volumeRequest);
        if (volumeSpec !== undefined) {
          const volume = volumeSpec;
          const exact = entries.find(
            (entry) =>
              entry.kind === "volume" &&
              entry.name === volume.name &&
              sameLabels(entry.labels, volume.labels),
          );
          if (exact === undefined) {
            const sameLabel = entries.find(
              (entry) => entry.kind === "volume" && sameLabels(entry.labels, volume.labels),
            );
            const sameName = entries.find(
              (entry) => entry.kind === "volume" && entry.name === volume.name,
            );
            if (sameLabel !== undefined || sameName !== undefined)
              return yield* toDriverError(key, new Error("Container volume identity collision"));
          }
        }
        const exact = entries.find(
          (entry) => entry.kind === "workload" && sameWorkloadIdentity(entry.labels, labels),
        );
        const namedCollision = entries.find(
          (entry) => entry.kind === "workload" && entry.name === nameFor(key, "workload"),
        );
        const collision =
          namedCollision !== undefined && isManagedContainer(namedCollision)
            ? namedCollision
            : undefined;
        if (
          exact === undefined &&
          namedCollision !== undefined &&
          (collision === undefined ||
            collision.labels.stackId !== key.stackId ||
            collision.labels.workloadId !== key.workloadId ||
            collision.labels.role !== "workload")
        )
          return yield* toDriverError(
            key,
            new Error("Container name is owned by another workload"),
          );

        const exactNetwork = entries
          .filter(isNetworkResource)
          .find((entry) => sameNetworkIdentity(entry.labels, networkLabels));
        const namedNetworkCollision = entries.find(
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

        if (exact === undefined)
          yield* withEngine(key, options.engine.inspectImage(artifact.image)).pipe(
            Effect.flatMap((inspected) =>
              inspected.present
                ? Effect.void
                : withEngine(key, options.engine.pullImage(artifact.image)),
            ),
          );

        if (exactNetwork === undefined && networkCollision !== undefined)
          yield* withEngine(key, options.engine.removeNetwork(networkCollision.id));
        const networkResource =
          exactNetwork ??
          (yield* withEngine(
            key,
            options.engine.createNetwork({ name: networkName, labels: networkLabels }),
          ));

        if (volumeSpec !== undefined) {
          const volume = volumeSpec;
          const exactVolume = entries.find(
            (entry) =>
              entry.kind === "volume" &&
              entry.name === volume.name &&
              sameLabels(entry.labels, volume.labels),
          );
          if (exactVolume === undefined)
            yield* withEngine(key, options.engine.createVolume(volume));
        }

        let container: ContainerResource;
        let created = false;
        let startedByUs = false;
        if (exact !== undefined) {
          container = exact;
          if (exact.state !== "running") {
            yield* withEngine(key, options.engine.startContainer(exact.id));
            startedByUs = true;
          }
        } else {
          if (collision !== undefined) {
            if (collision.state === "running")
              yield* withEngine(key, options.engine.stopContainer(collision.id));
            yield* withEngine(key, options.engine.removeContainer(collision.id));
          }
          container = yield* withEngine(
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
              ...(resolution.hostRoute === undefined ? {} : { hostRoute: resolution.hostRoute }),
              ...(resolution.command === undefined ? {} : { command: resolution.command }),
            } satisfies ContainerContainerSpec),
          );
          created = true;
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
          yield* withEngine(key, options.engine.startContainer(container.id));
          startedByUs = true;
        }
        const current = resources.get(resourceKey(key));
        const resource =
          current !== undefined && current.container === container.id && current.state === "running"
            ? current
            : yield* Effect.gen(function* () {
                const failure = yield* Deferred.make<never, RuntimeDriverError>();
                const createdResource: ContainerRuntimeResource = {
                  key,
                  workload,
                  container: container.id,
                  network: networkResource.id,
                  state: "running",
                  failure,
                  stopRequested: false,
                };
                resources.set(resourceKey(key), createdResource);
                return createdResource;
              });
        if (resource.logFiber === undefined) yield* attachLogs(resource, created ? "all" : 0);
        const readiness =
          resolution.waitForReadiness === undefined
            ? options.waitForReadiness === undefined
              ? Effect.void
              : options.waitForReadiness(key, workload, container)
            : resolution.waitForReadiness(key, workload, container);
        const startup = Effect.gen(function* () {
          yield* Effect.raceFirst(readiness, Deferred.await(resource.failure));
          if (workload.bootstrap === "database") {
            if (options.bootstrapDatabase === undefined)
              return yield* toDriverError(
                key,
                new Error("Database bootstrap resolver is not configured"),
              );
            yield* options.bootstrapDatabase(key, workload, container);
          }
        });
        const ready = yield* startup.pipe(Effect.exit);
        if (Exit.isFailure(ready)) {
          resource.stopRequested = true;
          yield* stopLogs(resource);
          const stopExit =
            startedByUs || workload.bootstrap === "database"
              ? yield* Effect.exit(withEngine(key, options.engine.stopContainer(container.id)))
              : Exit.succeed(undefined);
          const removeExit = created
            ? yield* Effect.exit(withEngine(key, options.engine.removeContainer(container.id)))
            : Exit.succeed(undefined);
          let cleanupCause: Cause.Cause<RuntimeDriverError> = Cause.empty;
          if (Exit.isFailure(stopExit)) cleanupCause = Cause.combine(cleanupCause, stopExit.cause);
          if (Exit.isFailure(removeExit))
            cleanupCause = Cause.combine(cleanupCause, removeExit.cause);
          resources.delete(resourceKey(key));
          return yield* cleanupCause.reasons.length === 0
            ? Effect.failCause(ready.cause)
            : Effect.failCause(Cause.combine(ready.cause, cleanupCause));
        }
        const result: ObservedWorkload = { ...key, state: "ready" };
        return result;
      });
      return lifecycle.withPermit(startEffect);
    };

    const stopInPermit = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> => {
      const found = resources.get(resourceKey(key));
      return found !== undefined
        ? found.state === "stopped"
          ? Effect.void
          : Effect.gen(function* () {
              found.stopRequested = true;
              yield* stopLogs(found);
              yield* withEngine(key, options.engine.stopContainer(found.container));
              resources.set(resourceKey(key), { ...found, state: "stopped" });
            })
        : withEngine(key, options.engine.listResources(key.stackId)).pipe(
            Effect.flatMap((entries) => {
              const exact = entries
                .filter(isWorkloadResource)
                .find((entry) =>
                  sameWorkloadIdentity(
                    entry.labels,
                    workloadLabelsFor(key, options.ownerSessionId),
                  ),
                );
              return exact === undefined
                ? Effect.void
                : exact.state === "running"
                  ? withEngine(key, options.engine.stopContainer(exact.id))
                  : Effect.void;
            }),
          );
    };

    const stop = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> =>
      lifecycle.withPermit(stopInPermit(key));

    const remove = (key: RuntimeWorkloadKey): Effect.Effect<void, RuntimeDriverError> =>
      lifecycle.withPermit(
        Effect.gen(function* () {
          const found = resources.get(resourceKey(key));
          if (found !== undefined) {
            found.stopRequested = true;
            yield* stopLogs(found);
            if (found.state !== "stopped")
              yield* withEngine(key, options.engine.stopContainer(found.container));
            yield* withEngine(key, options.engine.removeContainer(found.container));
            resources.delete(resourceKey(key));
            return;
          }
          const entries = yield* withEngine(key, options.engine.listResources(key.stackId));
          const exact = entries
            .filter(isWorkloadResource)
            .find((entry) =>
              sameWorkloadIdentity(entry.labels, workloadLabelsFor(key, options.ownerSessionId)),
            );
          if (exact === undefined) return;
          if (exact.state === "running")
            yield* withEngine(key, options.engine.stopContainer(exact.id));
          yield* withEngine(key, options.engine.removeContainer(exact.id));
        }),
      );

    const cleanup = (request: RuntimeCleanupRequest): Effect.Effect<void, RuntimeDriverError> =>
      lifecycle.withPermit(
        Effect.gen(function* () {
          const entries = yield* withEngine(
            { stackId: request.stackId, workloadId: "" },
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
            }

          // Stop and remove every stack workload before touching its network. A failed
          // stop does not prevent the remove attempt; all failures are returned together.
          for (const entry of owned.filter(isManagedContainer)) {
            if (entry.state === "running")
              yield* attempt(
                withEngine(
                  { stackId: request.stackId, workloadId: "" },
                  options.engine.stopContainer(entry.id),
                ),
              );
            yield* attempt(
              withEngine(
                { stackId: request.stackId, workloadId: "" },
                options.engine.removeContainer(entry.id),
              ),
            );
          }
          for (const entry of owned.filter(isNetworkResource))
            yield* attempt(
              withEngine(
                { stackId: request.stackId, workloadId: "" },
                options.engine.removeNetwork(entry.id),
              ),
            );
          if (request.destroy)
            for (const entry of owned.filter((candidate) => candidate.kind === "volume"))
              yield* attempt(
                withEngine(
                  { stackId: request.stackId, workloadId: "" },
                  options.engine.removeVolume(entry.id),
                ),
              );

          for (const id of resources.keys())
            if (id.startsWith(`${request.stackId}:`)) resources.delete(id);
          yield* Scope.close(runtimeScope, Exit.void);
          if (cleanupCause.reasons.length > 0) return yield* Effect.failCause(cleanupCause);
        }),
      );

    const recover = (
      request: RuntimeRecoveryRequest,
    ): Effect.Effect<ReadonlyArray<ObservedWorkload>, RuntimeDriverError> =>
      lifecycle.withPermit(
        Effect.gen(function* () {
          const entries = yield* withEngine(
            { stackId: request.stackId, workloadId: "" },
            options.engine.listResources(request.stackId),
          );
          const owned = entries
            .filter((entry) => entry.labels.stackId === request.stackId)
            .sort((left, right) => left.id.localeCompare(right.id));
          const desiredHashes = new Map(
            request.plan.workloads.map((workload) => [workload.id, workload.specHash]),
          );
          const desiredWorkloads = new Map(
            request.plan.workloads.map((workload) => [workload.id, workload]),
          );
          const adopted: Array<ObservedWorkload> = [];
          const adoptedResourceKeys = new Set<string>();
          const adoptedIdentities = new Set<string>();
          let retainedNetworkId: string | undefined;
          let recoveryCause: Cause.Cause<RuntimeDriverError> = Cause.empty;
          const attempt = <A>(effect: Effect.Effect<A, RuntimeDriverError>) =>
            Effect.gen(function* () {
              const result = yield* Effect.exit(effect);
              if (Exit.isFailure(result))
                recoveryCause = Cause.combine(recoveryCause, result.cause);
            });
          const stopAndRemove = (entry: ContainerResource) =>
            Effect.gen(function* () {
              if (entry.state === "running")
                yield* attempt(
                  withEngine(
                    { stackId: request.stackId, workloadId: "" },
                    options.engine.stopContainer(entry.id),
                  ),
                );
              yield* attempt(
                withEngine(
                  { stackId: request.stackId, workloadId: "" },
                  options.engine.removeContainer(entry.id),
                ),
              );
            });
          const stopAdopted = (
            entry: ContainerResource & { readonly labels: ContainerWorkloadLabels },
          ) =>
            withEngine(
              { stackId: request.stackId, workloadId: entry.labels.workloadId },
              options.engine.stopContainer(entry.id),
            );

          // Recovery never starts or creates anything. Workload identities are evaluated before
          // retaining the network so stale resources cannot leak into the new owner.
          for (const entry of owned.filter(isManagedContainer)) {
            const hash = desiredHashes.get(entry.labels.workloadId);
            const current =
              entry.labels.desiredGeneration === request.desiredGeneration &&
              hash !== undefined &&
              hash === entry.labels.specHash;
            if (!current) {
              yield* stopAndRemove(entry);
              continue;
            }
            const identity = `${entry.labels.desiredGeneration}:${entry.labels.workloadId}:${entry.labels.specHash}`;
            if (adoptedIdentities.has(identity)) {
              yield* stopAndRemove(entry);
              continue;
            }
            adoptedIdentities.add(identity);
            const desiredWorkload = desiredWorkloads.get(entry.labels.workloadId);
            const key: RuntimeWorkloadKey = {
              stackId: entry.labels.stackId,
              desiredGeneration: entry.labels.desiredGeneration,
              workloadId: entry.labels.workloadId,
              specHash: entry.labels.specHash,
            };
            if (entry.state === "running" && desiredWorkload !== undefined) {
              const readiness = options.waitForReadiness;
              if (readiness !== undefined) {
                const readinessExit = yield* Effect.exit(readiness(key, desiredWorkload, entry));
                if (Exit.isFailure(readinessExit)) {
                  recoveryCause = Cause.combine(recoveryCause, readinessExit.cause);
                  const stopExit = yield* Effect.exit(stopAdopted(entry));
                  if (Exit.isFailure(stopExit))
                    recoveryCause = Cause.combine(recoveryCause, stopExit.cause);
                  continue;
                }
              }
            }
            if (entry.state === "running" && desiredWorkload?.bootstrap === "database") {
              const bootstrap =
                options.bootstrapDatabase === undefined
                  ? Effect.fail(
                      toDriverError(
                        key,
                        new Error("Database bootstrap resolver is not configured"),
                      ),
                    )
                  : options.bootstrapDatabase(key, desiredWorkload, entry);
              const bootstrapExit = yield* Effect.exit(bootstrap);
              if (Exit.isFailure(bootstrapExit)) {
                recoveryCause = Cause.combine(recoveryCause, bootstrapExit.cause);
                const stopExit = yield* Effect.exit(stopAdopted(entry));
                if (Exit.isFailure(stopExit))
                  recoveryCause = Cause.combine(recoveryCause, stopExit.cause);
                continue;
              }
            }
            if (entry.state === "running" && desiredWorkload !== undefined) {
              const known = resources.get(resourceKey(key));
              if (known !== undefined && known.container === entry.id && known.state === "failed") {
                recoveryCause = Cause.combine(
                  recoveryCause,
                  Cause.fail(
                    toDriverError(key, new Error(known.error ?? "Container log stream failed")),
                  ),
                );
                known.stopRequested = true;
                const stopExit = yield* Effect.exit(stopAdopted(entry));
                if (Exit.isFailure(stopExit))
                  recoveryCause = Cause.combine(recoveryCause, stopExit.cause);
                yield* stopLogs(known);
                resources.delete(resourceKey(key));
                continue;
              }
              if (
                known !== undefined &&
                (known.container !== entry.id || known.state !== "running")
              ) {
                known.stopRequested = true;
                yield* stopLogs(known);
                resources.delete(resourceKey(key));
              }
              const resource =
                resources.get(resourceKey(key)) ??
                (yield* Effect.gen(function* () {
                  const failure = yield* Deferred.make<never, RuntimeDriverError>();
                  const adoptedResource: ContainerRuntimeResource = {
                    key,
                    workload: desiredWorkload,
                    container: entry.id,
                    network: retainedNetworkId ?? "",
                    state: "running",
                    failure,
                    stopRequested: false,
                  };
                  resources.set(resourceKey(key), adoptedResource);
                  return adoptedResource;
                }));
              if (resource.logFiber === undefined) yield* attachLogs(resource, 0);
              if (resource.state === "failed") {
                recoveryCause = Cause.combine(
                  recoveryCause,
                  Cause.fail(
                    toDriverError(key, new Error(resource.error ?? "Container log stream failed")),
                  ),
                );
                resource.stopRequested = true;
                const stopExit = yield* Effect.exit(stopAdopted(entry));
                if (Exit.isFailure(stopExit))
                  recoveryCause = Cause.combine(recoveryCause, stopExit.cause);
                resources.delete(resourceKey(key));
                continue;
              }
              adoptedResourceKeys.add(resourceKey(key));
            }
            adopted.push({
              stackId: entry.labels.stackId,
              desiredGeneration: entry.labels.desiredGeneration,
              workloadId: entry.labels.workloadId,
              specHash: entry.labels.specHash,
              state:
                entry.state === "running"
                  ? "ready"
                  : entry.state === "stopped"
                    ? "stopped"
                    : "starting",
            });
          }

          // Networks are only considered after all workloads. Keep one network for
          // the exact current generation; duplicate or stale-generation networks are ephemera.
          for (const entry of owned.filter(isNetworkResource)) {
            if (
              retainedNetworkId === undefined &&
              entry.labels.desiredGeneration === request.desiredGeneration
            ) {
              retainedNetworkId = entry.id;
              continue;
            }
            yield* attempt(
              withEngine(
                { stackId: request.stackId, workloadId: "" },
                options.engine.removeNetwork(entry.id),
              ),
            );
          }

          for (const [id, resource] of resources)
            if (id.startsWith(`${request.stackId}:`) && !adoptedResourceKeys.has(id)) {
              resource.stopRequested = true;
              yield* stopLogs(resource);
              resources.delete(id);
            }
          if (recoveryCause.reasons.length > 0) return yield* Effect.failCause(recoveryCause);
          return adopted;
        }),
      );

    return { observe, start, stop, remove, cleanup, recover } satisfies RuntimeDriver;
  });
