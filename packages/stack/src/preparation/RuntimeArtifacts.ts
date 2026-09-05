import { Crypto, Effect, FileSystem, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import {
  resolveNativeArtifactForWorkload,
  type NativeWorkloadArtifact,
} from "../model/WorkloadCatalog.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { ArtifactPreparationStatus } from "../public/Status.ts";
import {
  ContainerEngineError,
  ContainerPullError,
  StackPreparationError,
} from "../public/Errors.ts";
import {
  makeArtifactStore,
  type ArtifactStore,
  type ArtifactStoreError,
  type PreparedArtifact,
} from "./ArtifactStore.ts";
import { makeSlimServicesSource } from "./SlimServicesSource.ts";
import type { ContainerEngine } from "../runtime/ContainerEngine.ts";
import {
  resolveContainerEngine,
  type ContainerEngineResolverShape,
} from "../runtime/ContainerEngineResolver.ts";

/** Result of preparing one workload's immutable runtime artifact. */
export interface PreparedWorkloadArtifact {
  readonly workloadId: string;
  readonly capability: PlannedWorkload["capability"];
  readonly version: string;
  readonly outcome: "cached" | "downloaded" | "pulled";
  /** Native installation root. Container preparation deliberately has no root. */
  readonly artifactRoot?: string;
  readonly executablePath?: string;
  readonly image?: string;
}

export type RuntimeArtifactPreparationProgress = ArtifactPreparationStatus;
export type RuntimeArtifactPreparationProgressListener = (
  progress: RuntimeArtifactPreparationProgress,
) => void;

export interface RuntimeArtifactPreparer {
  readonly prepare: (
    runtime: StackRuntime,
    workload: PlannedWorkload,
    onProgress?: RuntimeArtifactPreparationProgressListener,
  ) => Effect.Effect<PreparedWorkloadArtifact, RuntimeArtifactPreparationError>;
}

export type RuntimeArtifactPreparationError =
  | ArtifactStoreError
  | StackPreparationError
  | ContainerEngineError
  | ContainerPullError;

export interface RuntimeArtifactPreparerOptions {
  readonly native?: {
    readonly store: ArtifactStore;
    /** Registers catalog metadata for the source that resolves a cache-miss request. */
    readonly onArtifactResolved?: (artifact: NativeWorkloadArtifact) => void;
    readonly platform?: { readonly os: string; readonly arch: string };
  };
  readonly containerEngine?: ContainerEngine;
}

const error = (message: string, fields: Readonly<Record<string, unknown>> = {}) =>
  new StackPreparationError({ message, ...fields });

const artifactKey = (artifact: NativeWorkloadArtifact): string =>
  `slim-services/${artifact.service}/${artifact.version}/${artifact.target}`;

const containerVersion = (image: string): string => {
  const separator = image.lastIndexOf(":");
  return separator > image.lastIndexOf("/") ? image.slice(separator + 1) : image;
};

/**
 * Prepares only immutable native/container artifacts. No containers, processes,
 * ports, secrets, or runtime resources are created by this boundary.
 */
export const makeRuntimeArtifactPreparer = (
  options: RuntimeArtifactPreparerOptions,
): RuntimeArtifactPreparer => {
  const prepare = (
    runtime: StackRuntime,
    workload: PlannedWorkload,
    onProgress?: RuntimeArtifactPreparationProgressListener,
  ): Effect.Effect<PreparedWorkloadArtifact, RuntimeArtifactPreparationError> =>
    Effect.suspend<PreparedWorkloadArtifact, RuntimeArtifactPreparationError, never>(() => {
      const report = (state: ArtifactPreparationStatus["state"], cause?: unknown): void => {
        onProgress?.({
          workloadId: workload.id,
          capability: workload.capability,
          state,
          ...(cause === undefined
            ? {}
            : {
                error:
                  cause instanceof Error
                    ? cause.message
                    : typeof cause === "string"
                      ? cause
                      : (JSON.stringify(cause) ?? "Unknown preparation failure"),
              }),
        });
      };
      report("preparing");
      if (runtime.kind === "native") {
        const native = options.native;
        if (native === undefined)
          return Effect.fail(
            error("Native runtime has no configured artifact store", { workload: workload.id }),
          );
        if (workload.selected.kind !== "native")
          return Effect.fail(
            error("Native runtime received a container workload artifact", {
              workload: workload.id,
            }),
          );
        return Effect.gen(function* () {
          const artifact = yield* resolveNativeArtifactForWorkload(workload, native.platform);
          native.onArtifactResolved?.(artifact);
          const request = {
            key: artifactKey(artifact),
            requiredRuntimePaths: artifact.requiredRuntimePaths,
            executablePath: artifact.executablePath,
          };
          const prepared = yield* native.store.prepare(request, (state) => report(state));
          report("ready");
          return nativeResult(workload, artifact, prepared);
        }).pipe(Effect.tapError((cause) => Effect.sync(() => report("failed", cause))));
      }
      if (workload.selected.kind !== "container")
        return Effect.fail(
          error("Container runtime received a native workload artifact", {
            workload: workload.id,
          }),
        );
      const engine = options.containerEngine;
      if (engine === undefined)
        return Effect.fail(
          error("Container runtime has no configured container engine", {
            workload: workload.id,
            engine: runtime.engine,
          }),
        );
      if (engine.kind !== runtime.engine)
        return Effect.fail(
          error("Configured container engine does not match runtime", {
            workload: workload.id,
            engine: runtime.engine,
            configuredEngine: engine.kind,
          }),
        );
      const image = workload.selected.image;
      return engine.probe.pipe(
        Effect.andThen(engine.inspectImage(image)),
        Effect.flatMap((inspection) =>
          inspection.present
            ? Effect.succeed<PreparedWorkloadArtifact>({
                workloadId: workload.id,
                capability: workload.capability,
                version: containerVersion(image),
                outcome: "cached",
                image,
              })
            : Effect.sync(() => report("downloading")).pipe(
                Effect.andThen(engine.pullImage(image)),
                Effect.mapError(
                  (cause) =>
                    new ContainerPullError({
                      message: `Unable to pull container image ${image}`,
                      workload: workload.id,
                      cause,
                    }),
                ),
                Effect.as({
                  workloadId: workload.id,
                  capability: workload.capability,
                  version: containerVersion(image),
                  outcome: "pulled" as const,
                  image,
                }),
              ),
        ),
        Effect.tap(() => Effect.sync(() => report("ready"))),
        Effect.mapError((cause) =>
          cause instanceof ContainerPullError
            ? cause
            : new ContainerEngineError({
                message:
                  cause instanceof Error ? cause.message : "Container engine operation failed",
                engine: runtime.engine,
                cause,
              }),
        ),
        Effect.tapError((cause) => Effect.sync(() => report("failed", cause))),
      );
    });
  return { prepare };
};

const nativeResult = (
  workload: PlannedWorkload,
  artifact: NativeWorkloadArtifact,
  prepared: PreparedArtifact,
): PreparedWorkloadArtifact => ({
  workloadId: workload.id,
  capability: workload.capability,
  version: artifact.version,
  outcome: prepared.outcome,
  artifactRoot: prepared.path,
  executablePath: prepared.executablePath,
});

/**
 * Production constructor. The artifact cache is shared below stateRoot rather
 * than inside a stack's data directory; container engines are selected from
 * persisted runtime state by prepare().
 */
export const makeProductionRuntimeArtifactPreparer = (options: {
  readonly stateRoot: string;
  /** Optional cache root shared across disposable stack state roots. */
  readonly artifactCacheRoot?: string;
  readonly runtime?: StackRuntime;
  /** Optional already-selected engine owned by the production runtime. */
  readonly containerEngine?: ContainerEngine;
  /** Test seam for caller-owned preparation when no engine was supplied. */
  readonly containerEngineResolver?: ContainerEngineResolverShape;
}): Effect.Effect<
  RuntimeArtifactPreparer,
  RuntimeArtifactPreparationError,
  Path.Path | FileSystem.FileSystem | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    if (options.stateRoot.trim().length === 0)
      return yield* error("Artifact cache state root must not be blank");
    const path = yield* Path.Path;
    if (options.artifactCacheRoot !== undefined && options.artifactCacheRoot.trim().length === 0)
      return yield* error("Artifact cache root must not be blank");
    const cacheRoot =
      options.artifactCacheRoot === undefined
        ? path.join(path.resolve(options.stateRoot), "artifacts")
        : path.resolve(options.artifactCacheRoot);
    const artifacts = new Map<string, NativeWorkloadArtifact>();
    const store =
      options.runtime?.kind === "container"
        ? undefined
        : yield* makeArtifactStore({
            cacheRoot,
            source: makeSlimServicesSource((request) => artifacts.get(request.key)),
          });
    const registerArtifact = (artifact: NativeWorkloadArtifact) => {
      artifacts.set(artifactKey(artifact), artifact);
    };
    const selectedEngine =
      options.runtime?.kind === "container" ? options.runtime.engine : undefined;
    const containerEngine =
      options.containerEngine ??
      (selectedEngine === undefined
        ? undefined
        : yield* resolveContainerEngine(selectedEngine, options.containerEngineResolver).pipe(
            Effect.mapError(
              (cause) =>
                new ContainerEngineError({
                  message: `Unable to configure ${selectedEngine} artifact engine`,
                  engine: selectedEngine,
                  cause,
                }),
            ),
          ));
    const preparer = makeRuntimeArtifactPreparer({
      ...(store === undefined ? {} : { native: { store, onArtifactResolved: registerArtifact } }),
      ...(containerEngine === undefined ? {} : { containerEngine }),
    });
    return preparer;
  });
