import { Context, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ContainerEngineError } from "../public/Errors.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import {
  makeProcessCommandRunner,
  type ContainerEngine,
  ContainerCommandError,
  type ContainerEngineFailure,
  type ContainerEngineKind,
  type ContainerPlatform,
} from "./ContainerEngine.ts";
import { makeDockerEngine } from "./DockerEngine.ts";
import { makePodmanEngine } from "./PodmanEngine.ts";

/**
 * Host-composition seam for selecting one concrete container engine, kept narrow so
 * createStack can be tested without a local daemon while production uses the real Docker/Podman
 * adapters.
 */
export interface ContainerEngineResolverShape {
  /** Checks for an installed client without requiring a running daemon. */
  readonly isInstalled: (
    kind: ContainerEngineKind,
  ) => Effect.Effect<boolean, ContainerEngineFailure, ChildProcessSpawner>;
  /**
   * Checks daemon liveness. Omitted on test doubles: auto-select then treats an installed client
   * as reachable.
   */
  readonly isDaemonReachable?: (
    kind: ContainerEngineKind,
  ) => Effect.Effect<boolean, ContainerEngineFailure, ChildProcessSpawner>;
  readonly resolve: (
    preference: ContainerEngineKind,
  ) => Effect.Effect<ContainerEngine, ContainerEngineFailure, ChildProcessSpawner>;
}

/** @effect-expect-leaking ChildProcessSpawner */
export class ContainerEngineResolver extends Context.Service<
  ContainerEngineResolver,
  ContainerEngineResolverShape
>()("@supabase/stack/ContainerEngineResolver") {}

const hostContainerPlatform = (): ContainerPlatform => {
  if (process.platform === "darwin") return { os: "darwin", desktop: true };
  if (process.platform === "win32") return { os: "windows", desktop: true };
  return { os: "linux", desktop: false };
};

const DOCKER_PROBE_TIMEOUT = "2 seconds";

const processUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

export const nativeRuntimeBlockedForUid = (uid = processUid()): boolean => uid === 0;

export const NATIVE_ROOT_UNSUPPORTED_MESSAGE =
  "Native Postgres cannot run as uid 0 because initdb refuses root. Use --runtime docker.";

export const DOCKER_DAEMON_FALLBACK_NOTICE =
  "Docker daemon is not reachable; using native Postgres. This runtime is persisted for this stack. To use Docker later, run stack destroy and start again, or choose a new --stack name.";

export interface DefaultRuntimeSelection {
  readonly runtime: StackRuntime;
  readonly dockerFallbackNotice?: string;
}

export interface SelectDefaultRuntimeOptions {
  readonly uid?: number;
}

export const defaultContainerEngineResolver: ContainerEngineResolverShape = {
  isInstalled: (kind) =>
    Effect.gen(function* () {
      const runner = yield* makeProcessCommandRunner({ executable: kind });
      const result = yield* runner.run({ args: ["--version"] });
      if (result.exitCode !== 0)
        return yield* new ContainerCommandError({
          operation: "version",
          exitCode: result.exitCode,
          message: `${kind} --version exited (${String(result.exitCode)})`,
        });
      return true;
    }).pipe(Effect.catchTag("ContainerExecutableNotFoundError", () => Effect.succeed(false))),
  isDaemonReachable: (kind) =>
    Effect.gen(function* () {
      const engine = yield* defaultContainerEngineResolver.resolve(kind);
      return yield* engine.probe.pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: DOCKER_PROBE_TIMEOUT,
          orElse: () => Effect.succeed(false),
        }),
        Effect.orElseSucceed(() => false),
      );
    }),
  resolve: (kind) =>
    Effect.gen(function* () {
      const runner = yield* makeProcessCommandRunner({ executable: kind });
      const platform = hostContainerPlatform();
      return kind === "docker"
        ? makeDockerEngine({ runner, platform })
        : makePodmanEngine({ runner, platform });
    }),
};

export const resolveContainerEngine = (
  kind: ContainerEngineKind,
  resolver?: ContainerEngineResolverShape,
): Effect.Effect<ContainerEngine, ContainerEngineFailure, ChildProcessSpawner> =>
  (resolver ?? defaultContainerEngineResolver).resolve(kind);

const mapSelectError = (error: ContainerEngineFailure): ContainerEngineError =>
  new ContainerEngineError({
    engine: "docker",
    message: `Unable to determine whether Docker is installed: ${error.message}`,
    cause: error,
  });

/** Docker when the daemon is reachable, otherwise native (unless uid 0). */
export const selectDefaultRuntimeSelection = (
  resolver?: ContainerEngineResolverShape,
  options?: SelectDefaultRuntimeOptions,
): Effect.Effect<DefaultRuntimeSelection, ContainerEngineError, ChildProcessSpawner> => {
  const selected = resolver ?? defaultContainerEngineResolver;
  return Effect.gen(function* () {
    const installed = yield* selected.isInstalled("docker").pipe(Effect.mapError(mapSelectError));
    const reachable = !installed
      ? false
      : selected.isDaemonReachable === undefined
        ? true
        : yield* selected.isDaemonReachable("docker").pipe(
            Effect.mapError(mapSelectError),
            Effect.orElseSucceed(() => false),
          );
    if (reachable)
      return { runtime: { kind: "container", engine: "docker" } satisfies StackRuntime };
    if (nativeRuntimeBlockedForUid(options?.uid ?? processUid()))
      return yield* new ContainerEngineError({
        engine: "docker",
        message: NATIVE_ROOT_UNSUPPORTED_MESSAGE,
      });
    return {
      runtime: { kind: "native" } satisfies StackRuntime,
      ...(installed ? { dockerFallbackNotice: DOCKER_DAEMON_FALLBACK_NOTICE } : {}),
    };
  });
};

export const selectDefaultRuntime = (
  resolver?: ContainerEngineResolverShape,
  options?: SelectDefaultRuntimeOptions,
): Effect.Effect<StackRuntime, ContainerEngineError, ChildProcessSpawner> =>
  selectDefaultRuntimeSelection(resolver, options).pipe(Effect.map((selected) => selected.runtime));
