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
            .filter(
              (entry) =>
                entry.labels.ownerSessionId === options.ownerSessionId &&
                entry.labels.stackId === stackId,
            )
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
          (entry) => isManagedContainer(entry) && sameLabels(entry.labels, labels),
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
            collision.labels.ownerSessionId !== options.ownerSessionId ||
            collision.labels.workloadId !== key.workloadId ||
            collision.labels.role !== "workload")
        )
          return yield* toDriverError(
            key,
            new Error("Container name is owned by another workload"),
          );

        const exactNetwork = entries
          .filter(isNetworkResource)
          .find((entry) => sameLabels(entry.labels, networkLabels));
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
          (networkCollision === undefined ||
            networkCollision.labels.stackId !== key.stackId ||
            networkCollision.labels.ownerSessionId !== options.ownerSessionId)
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
                .find(
                  (entry) =>
                    entry.labels.ownerSessionId === options.ownerSessionId &&
                    sameLabels(entry.labels, workloadLabelsFor(key, options.ownerSessionId)),
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
              sameLabels(entry.labels, workloadLabelsFor(key, options.ownerSessionId)),
            );
          if (exact === undefined) return;
          if (exact.state === "running")
            yield* withEngine(key, options.engine.stopContainer(exact.id));
          yield* withEngine(key, options.engine.removeContainer(exact.id));
        }),
      );

    return { observe, start, stop, remove } satisfies RuntimeDriver;
  });
