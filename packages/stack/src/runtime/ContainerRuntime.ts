import { Cause, Effect, Exit, Semaphore } from "effect";
import type { ContainerArtifact } from "../model/CapabilityModule.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { StackId } from "../public/StackId.ts";
import {
  type ContainerContainerSpec,
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
}

export interface ContainerWorkloadResolution {
  readonly mounts?: ReadonlyArray<ContainerMount>;
  readonly volume?: ContainerVolumeRequest;
  readonly env?: Readonly<Record<string, string>>;
  readonly command?: ReadonlyArray<string>;
  readonly waitForReadiness?: (
    key: RuntimeWorkloadKey,
    workload: PlannedWorkload,
    resource: ContainerResource,
  ) => Effect.Effect<void, RuntimeDriverError>;
}

export interface ContainerVolumeRequest {
  readonly target: string;
  readonly readOnly: boolean;
}

export interface ContainerRuntimeResourceIds {
  readonly container: string;
  readonly network: string;
  readonly state: "running" | "stopped";
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
const volumeLabelsFor = (key: RuntimeWorkloadKey): ContainerVolumeLabels => ({
  stackId: key.stackId,
  workloadId: key.workloadId,
  role: "volume",
});
const volumeNameFor = (key: RuntimeWorkloadKey): string =>
  `supabase-${key.stackId}-${key.workloadId.replace(/[^A-Za-z0-9_.-]/g, "-")}-volume`;
const volumeSpecFor = (key: RuntimeWorkloadKey): ContainerVolumeSpec => ({
  name: volumeNameFor(key),
  labels: volumeLabelsFor(key),
});
const volumeMountFor = (
  key: RuntimeWorkloadKey,
  request: ContainerVolumeRequest,
): ContainerVolumeMount => ({
  volume: volumeNameFor(key),
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
  (entry.kind === "workload" || entry.kind === "gateway") &&
  (entry.labels.role === "workload" || entry.labels.role === "gateway");

const isNetworkResource = (
  entry: ContainerResource,
): entry is ContainerResource & { readonly labels: ContainerNetworkLabels } =>
  entry.kind === "network" && entry.labels.role === "network";

/** RuntimeDriver implementation backed by one exact, injected container engine. */
export const makeContainerRuntime = (
  options: ContainerRuntimeOptions,
): Effect.Effect<RuntimeDriver, never> =>
  Effect.gen(function* () {
    const lifecycle = yield* Semaphore.make(1);
    const resources = new Map<string, ContainerRuntimeResourceIds>();

    const withEngine = <A>(
      key: Pick<RuntimeWorkloadKey, "stackId" | "workloadId">,
      effect: Effect.Effect<A, ContainerEngineFailure>,
    ): Effect.Effect<A, RuntimeDriverError> =>
      effect.pipe(Effect.mapError((error) => toDriverError(key, error)));

    const observe = (
      stackId: StackId,
    ): Effect.Effect<ReadonlyArray<ObservedWorkload>, RuntimeDriverError> =>
      withEngine({ stackId, workloadId: "" }, options.engine.listResources(stackId)).pipe(
        Effect.map((entries) =>
          entries
            .filter(isWorkloadResource)
            .filter((entry) => entry.labels.stackId === stackId)
            .map((entry) => ({
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
            })),
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
        yield* withEngine(key, options.engine.preflight);
        const resolution = yield* resolved;
        const volumeRequest = resolution.volume;
        if (volumeRequest !== undefined && volumeRequest.target.length === 0)
          return yield* toDriverError(key, new Error("Container volume mapping is invalid"));
        const entries = yield* withEngine(key, options.engine.listResources(key.stackId));
        const volumeSpec = volumeRequest === undefined ? undefined : volumeSpecFor(key);
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
          (entry) =>
            (entry.kind === "workload" || entry.kind === "gateway") &&
            entry.name === nameFor(key, "workload"),
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
              publications: [],
              volumeMounts: volumeRequest === undefined ? [] : [volumeMountFor(key, volumeRequest)],
              role: "workload",
              ...(resolution.env === undefined ? {} : { env: resolution.env }),
              ...(resolution.command === undefined ? {} : { command: resolution.command }),
            } satisfies ContainerContainerSpec),
          );
          created = true;
          yield* withEngine(key, options.engine.startContainer(container.id));
          startedByUs = true;
        }
        const readiness =
          resolution.waitForReadiness === undefined
            ? Effect.void
            : resolution.waitForReadiness(key, workload, container);
        const ready = yield* readiness.pipe(Effect.exit);
        if (Exit.isFailure(ready)) {
          const stopExit = startedByUs
            ? yield* Effect.exit(withEngine(key, options.engine.stopContainer(container.id)))
            : Exit.succeed(undefined);
          const removeExit = created
            ? yield* Effect.exit(withEngine(key, options.engine.removeContainer(container.id)))
            : Exit.succeed(undefined);
          let cleanupCause: Cause.Cause<RuntimeDriverError> = Cause.empty;
          if (Exit.isFailure(stopExit)) cleanupCause = Cause.combine(cleanupCause, stopExit.cause);
          if (Exit.isFailure(removeExit))
            cleanupCause = Cause.combine(cleanupCause, removeExit.cause);
          return yield* cleanupCause.reasons.length === 0
            ? Effect.failCause(ready.cause)
            : Effect.failCause(Cause.combine(ready.cause, cleanupCause));
        }
        resources.set(resourceKey(key), {
          container: container.id,
          network: networkResource.id,
          state: "running",
        });
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
          : withEngine(key, options.engine.stopContainer(found.container)).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  resources.set(resourceKey(key), { ...found, state: "stopped" });
                }),
              ),
            )
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
            if (found.state === "running")
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

          // Stop and remove every stack workload/gateway before touching its network. A failed
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
          const adopted: Array<ObservedWorkload> = [];
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

          // Recovery never starts or creates anything. Every gateway is removed first so a new
          // owner cannot expose stale ingress while workload identities are being evaluated.
          for (const entry of owned.filter(isManagedContainer)) {
            if (entry.kind === "gateway") {
              yield* stopAndRemove(entry);
              continue;
            }
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

          // Networks are only considered after all containers and gateways. Keep one network for
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

          for (const id of resources.keys())
            if (id.startsWith(`${request.stackId}:`)) resources.delete(id);
          if (recoveryCause.reasons.length > 0) return yield* Effect.failCause(recoveryCause);
          return adopted;
        }),
      );

    return { observe, start, stop, remove, cleanup, recover } satisfies RuntimeDriver;
  });
