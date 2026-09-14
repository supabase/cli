import { Context, Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
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

export const defaultContainerEngineResolver: ContainerEngineResolverShape = {
  isInstalled: (kind) =>
    Effect.gen(function* () {
      const runner = yield* makeProcessCommandRunner({ executable: kind });
      const result = yield* runner.run({ args: ["--version"] });
      if (result.exitCode !== 0)
        return yield* new ContainerCommandError({
          operation: "version",
          message: `${kind} --version exited (${String(result.exitCode)})`,
        });
      return true;
    }).pipe(Effect.catchTag("ContainerExecutableNotFoundError", () => Effect.succeed(false))),
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
