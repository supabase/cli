import { Effect, Exit } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { StackBuildError } from "./errors.ts";
import type { StackMode } from "./StackConfig.ts";

export type ContainerRuntime = "docker" | "podman";

export type StackRuntimeSelection =
  | { readonly mode: "native"; readonly containerRuntime: null }
  | { readonly mode: "docker"; readonly containerRuntime: ContainerRuntime };

export const selectStackRuntime = (
  requestedMode?: StackMode,
): Effect.Effect<StackRuntimeSelection, StackBuildError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    if (requestedMode === "native") {
      return { mode: "native", containerRuntime: null };
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimes: ReadonlyArray<ContainerRuntime> = ["docker", "podman"];
    for (const runtime of runtimes) {
      const result = yield* Effect.exit(
        spawner.exitCode(ChildProcess.make(runtime, ["info"])).pipe(Effect.timeout("3 seconds")),
      );
      if (Exit.isSuccess(result) && result.value === 0) {
        return { mode: "docker", containerRuntime: runtime };
      }
    }

    if (requestedMode === "docker") {
      return yield* Effect.fail(
        new StackBuildError({
          detail: "Docker mode requires a usable Docker or Podman runtime",
          reason: "docker_not_running",
        }),
      );
    }

    return { mode: "native", containerRuntime: null };
  });
