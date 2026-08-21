import { Effect, Exit } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { StackBuildError } from "./errors.ts";
import { detectPlatform, nativeTargetForPlatform, type PlatformInfo } from "./Platform.ts";
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
  selection.mode === "native"
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

export const selectStackRuntimeForPlatform = (
  platform: PlatformInfo,
  requestedMode?: StackMode,
): Effect.Effect<StackRuntimeSelection, StackBuildError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    if (requestedMode === "native") {
      if (nativeTargetForPlatform(platform) !== undefined) {
        return { mode: "native", containerRuntime: null };
      }
      return yield* Effect.fail(
        new StackBuildError({
          detail: `Native mode is unavailable on ${platform.os}-${platform.arch}. Use a supported Linux or Apple silicon macOS host, or install and start Docker or Podman.`,
          reason: "invalid_config",
        }),
      );
    }

    const runtimes = ["docker", "podman"] as const satisfies ReadonlyArray<ContainerRuntime>;
    const probes = yield* Effect.all(
      runtimes.map((runtime) =>
        probeContainerRuntime(runtime).pipe(Effect.map((usable) => [runtime, usable] as const)),
      ),
      { concurrency: "unbounded" },
    );
    const selected = probes.find(([, usable]) => usable)?.[0];
    if (selected !== undefined) {
      return { mode: "docker", containerRuntime: selected };
    }

    if (requestedMode === "docker") {
      return yield* Effect.fail(
        new StackBuildError({
          detail: "Docker mode requires a usable Docker or Podman runtime",
          reason: "docker_not_running",
        }),
      );
    }

    if (nativeTargetForPlatform(platform) !== undefined) {
      return { mode: "native", containerRuntime: null };
    }
    return yield* Effect.fail(
      new StackBuildError({
        detail: `No usable Docker or Podman runtime was found, and native mode is unavailable on ${platform.os}-${platform.arch}. Install and start Docker or Podman.`,
        reason: "docker_not_running",
      }),
    );
  });

export const selectStackRuntime = (
  requestedMode?: StackMode,
): Effect.Effect<StackRuntimeSelection, StackBuildError, ChildProcessSpawner.ChildProcessSpawner> =>
  detectPlatform.pipe(
    Effect.flatMap((platform) => selectStackRuntimeForPlatform(platform, requestedMode)),
  );
