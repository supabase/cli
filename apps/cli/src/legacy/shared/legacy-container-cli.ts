import { Effect } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

/**
 * Container CLIs tried in order: Docker is preferred, Podman is the fallback
 * for Docker-less hosts (e.g. Podman-only Linux setups).
 *
 * Both helpers fall back to `podman` only when the `docker` executable cannot
 * be spawned. Once a runtime starts, its container/daemon exit code and stderr
 * propagate unchanged, so callers keep Docker's error semantics. This mirrors
 * the `gen types --local` behaviour in `commands/gen/types/types.handler.ts`.
 */

type Spawner = ChildProcessSpawner["Service"];

/**
 * Spawn a container-CLI command and return the process handle. Use when the
 * caller needs to read stdout/stderr or await the exit code itself.
 */
export const spawnContainerCli = (
  spawner: Spawner,
  args: ReadonlyArray<string>,
  options?: ChildProcess.CommandOptions,
) =>
  spawner
    .spawn(ChildProcess.make("docker", args, options))
    .pipe(Effect.catch(() => spawner.spawn(ChildProcess.make("podman", args, options))));

/**
 * Run a container-CLI command and resolve to its exit code, mirroring the
 * spawner's `exitCode` convenience for callers that only need the status.
 */
export const containerCliExitCode = (
  spawner: Spawner,
  args: ReadonlyArray<string>,
  options?: ChildProcess.CommandOptions,
) =>
  spawner
    .exitCode(ChildProcess.make("docker", args, options))
    .pipe(Effect.catch(() => spawner.exitCode(ChildProcess.make("podman", args, options))));
