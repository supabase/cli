import { Effect, Exit } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { StackBuildError } from "./errors.ts";
import type { StackMode } from "./StackConfig.ts";

export type ContainerRuntime = "docker" | "podman";

export type StackRuntimeSelection =
  | { readonly mode: "native"; readonly containerRuntime: null }
  | { readonly mode: "docker"; readonly containerRuntime: ContainerRuntime };

const probeContainerRuntime = (
  runtime: ContainerRuntime,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const result = yield* Effect.exit(
      spawner.exitCode(ChildProcess.make(runtime, ["info"])).pipe(Effect.timeout("30 seconds")),
    );
    return Exit.isSuccess(result) && result.value === 0;
  });

export const validateStackRuntime = (
  selection: StackRuntimeSelection,
): Effect.Effect<
  StackRuntimeSelection,
  StackBuildError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  selection.containerRuntime === null
    ? Effect.succeed(selection)
    : probeContainerRuntime(selection.containerRuntime).pipe(
        Effect.flatMap((usable) =>
          usable
            ? Effect.succeed(selection)
            : Effect.fail(
                new StackBuildError({
                  detail: `Docker mode requires a usable ${selection.containerRuntime} runtime. Restore or start the persisted ${selection.containerRuntime} runtime and retry, or delete and recreate the stack (removing its managed data) to choose another execution mode.`,
                  reason: "docker_not_running",
                }),
              ),
        ),
      );

export const selectStackRuntime = (
  requestedMode?: StackMode,
): Effect.Effect<StackRuntimeSelection, StackBuildError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    if (requestedMode === "native") {
      return { mode: "native", containerRuntime: null };
    }

    const runtimes: ReadonlyArray<ContainerRuntime> = ["docker", "podman"];
    for (const runtime of runtimes) {
      if (yield* probeContainerRuntime(runtime)) {
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
