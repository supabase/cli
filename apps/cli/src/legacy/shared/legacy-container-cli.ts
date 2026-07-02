import { Data, Effect } from "effect";
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
 * Raised when neither `docker` nor `podman` can be spawned at all (e.g. neither
 * is installed or on `PATH`) — distinct from a spawned process exiting non-zero.
 * Not exported: callers never need to match on this type directly, they fold it
 * into their own tagged error via {@link legacyDescribeContainerCliFailure} so
 * the "no runtime found" root cause survives instead of collapsing into a
 * generic "failed to ..." message.
 */
class LegacyContainerRuntimeNotFoundError extends Data.TaggedError(
  "LegacyContainerRuntimeNotFoundError",
)<{
  readonly message: string;
}> {}

const RUNTIME_NOT_FOUND_MESSAGE =
  "docker: command not found (podman also not found) — install Docker Desktop or Podman and ensure it is on PATH";

/**
 * Renders a caller-facing suffix for a `spawnContainerCli`/`containerCliExitCode`
 * failure: the clear "neither runtime found" message when that's the cause,
 * otherwise the underlying cause's own message (falling back to `String(cause)`
 * for non-`Error` causes) so callers never collapse a real failure reason into a
 * bare, uninformative "failed to ..." string.
 */
export function legacyDescribeContainerCliFailure(cause: unknown): string {
  if (cause instanceof LegacyContainerRuntimeNotFoundError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

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
    .pipe(
      Effect.catch(() =>
        spawner
          .spawn(ChildProcess.make("podman", args, options))
          .pipe(
            Effect.catch(() =>
              Effect.fail(
                new LegacyContainerRuntimeNotFoundError({ message: RUNTIME_NOT_FOUND_MESSAGE }),
              ),
            ),
          ),
      ),
    );

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
    .pipe(
      Effect.catch(() =>
        spawner
          .exitCode(ChildProcess.make("podman", args, options))
          .pipe(
            Effect.catch(() =>
              Effect.fail(
                new LegacyContainerRuntimeNotFoundError({ message: RUNTIME_NOT_FOUND_MESSAGE }),
              ),
            ),
          ),
      ),
    );
