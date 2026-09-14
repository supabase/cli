import { Data, Effect, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Container CLIs tried in order: Docker preferred, Podman as the fallback for Docker-less hosts.
 * A runtime's own exit code and stderr propagate unchanged once it starts, so callers keep
 * Docker's error semantics regardless of which runtime answered.
 */

type Spawner = ChildProcessSpawner["Service"];

/**
 * Raised when neither `docker` nor `podman` can be spawned at all, as opposed to a spawned
 * process exiting non-zero. Callers fold this into their own tagged error via
 * {@link describeContainerCliFailure} so the "no runtime found" root cause survives.
 */
export class ContainerRuntimeNotFoundError extends Data.TaggedError(
  "ContainerRuntimeNotFoundError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** Matched by `docker-suggest.ts`'s daemon-unreachable classifier; keep the two in sync. */
export const containerRuntimeNotFoundMessage =
  "docker: command not found (podman also not found) — install Docker Desktop or Podman and ensure it is on PATH";

/** Formats a `spawnContainerCli`/`containerCliExitCode` failure cause for display. */
export function describeContainerCliFailure(cause: unknown): string {
  if (cause instanceof ContainerRuntimeNotFoundError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** Which of the two supported container CLIs actually answered a spawn. */
export type ContainerRuntime = "docker" | "podman";

/**
 * {@link spawnContainerCli}, but also reports which runtime answered, for callers that print a
 * command for the user to copy — naming `docker` on a Podman-only host would be unusable.
 */
export const spawnContainerCliWithRuntime = (
  spawner: Spawner,
  args: ReadonlyArray<string>,
  options?: ChildProcess.CommandOptions,
) =>
  spawner.spawn(ChildProcess.make("docker", args, options)).pipe(
    Effect.map((handle) => ({ handle, runtime: dockerRuntime })),
    Effect.catch(() =>
      spawner.spawn(ChildProcess.make("podman", args, options)).pipe(
        Effect.map((handle) => ({ handle, runtime: podmanRuntime })),
        Effect.catch(() =>
          Effect.fail(
            new ContainerRuntimeNotFoundError({
              message: containerRuntimeNotFoundMessage,
            }),
          ),
        ),
      ),
    ),
  );

const dockerRuntime: ContainerRuntime = "docker";
const podmanRuntime: ContainerRuntime = "podman";

/**
 * Spawn a container-CLI command and return the process handle. Use when the
 * caller needs to read stdout/stderr or await the exit code itself.
 */
export const spawnContainerCli = (
  spawner: Spawner,
  args: ReadonlyArray<string>,
  options?: ChildProcess.CommandOptions,
) => spawnContainerCliWithRuntime(spawner, args, options).pipe(Effect.map((it) => it.handle));

/**
 * Runs a container-CLI command and resolves to its exit code.
 *
 * `podmanArgs` lets a caller pass different argv to the Podman fallback for a subcommand that
 * isn't drop-in compatible between the two (e.g. `volume prune --all`, Docker-only).
 */
export const containerCliExitCode = (
  spawner: Spawner,
  args: ReadonlyArray<string>,
  options?: ChildProcess.CommandOptions,
  podmanArgs?: ReadonlyArray<string>,
) =>
  spawner.exitCode(ChildProcess.make("docker", args, options)).pipe(
    Effect.catch(() =>
      spawner.exitCode(ChildProcess.make("podman", podmanArgs ?? args, options)).pipe(
        Effect.catch(() =>
          Effect.fail(
            new ContainerRuntimeNotFoundError({
              message: containerRuntimeNotFoundMessage,
            }),
          ),
        ),
      ),
    ),
  );

/** Folds a byte stream into a decoded string, preserving the stream's own failure type. */
export function collectText<E>(stream: Stream.Stream<Uint8Array, E>) {
  const decoder = new TextDecoder();
  return Stream.runFold(
    stream,
    () => "",
    (text, chunk) => text + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.map((text) => text + decoder.decode()));
}

/**
 * Matches "container doesn't exist" stderr from `container inspect`: Docker's "No such
 * container"/"No such object" (casing varies by daemon version), or Podman's "no container with
 * name or ID ... found: no such container". Case-insensitive so callers can tolerate an
 * already-absent container instead of treating it as a hard failure.
 */
export function isContainerNotFoundMessage(message: string): boolean {
  return (
    /no such container/iu.test(message) ||
    /no such object/iu.test(message) ||
    /no container with name or id/iu.test(message)
  );
}

/**
 * Runs a container-CLI command that must succeed outright, failing on a spawn error or any
 * non-zero exit.
 *
 * @param verb - Human-readable action embedded in the error message, e.g. `"remove container"` →
 * `"failed to remove container: <cause>"`.
 */
export function runContainerCliExpectSuccess<E>(
  spawner: Spawner,
  args: ReadonlyArray<string>,
  verb: string,
  makeError: (message: string) => E,
): Effect.Effect<void, E> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }).pipe(
        Effect.mapError((cause) =>
          makeError(`failed to ${verb}: ${describeContainerCliFailure(cause)}`),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stderr)],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError(() => makeError(`failed to ${verb}`)));
      if (exitCode !== 0) {
        const message = stderr.trim();
        return yield* Effect.fail(
          makeError(message.length > 0 ? `failed to ${verb}: ${message}` : `failed to ${verb}`),
        );
      }
    }),
  );
}

/**
 * Like {@link containerCliExitCode}, but also returns the child's stdout — reading it instead of
 * ignoring it avoids the process hanging on an unread pipe. `podmanArgs` behaves the same as on
 * {@link containerCliExitCode}.
 */
export const containerCliExitCodeAndStdout = (
  spawner: Spawner,
  args: ReadonlyArray<string>,
  podmanArgs?: ReadonlyArray<string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const options = {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      } satisfies ChildProcess.CommandOptions;
      const handle = yield* spawner.spawn(ChildProcess.make("docker", args, options)).pipe(
        Effect.catch(() =>
          spawner.spawn(ChildProcess.make("podman", podmanArgs ?? args, options)).pipe(
            Effect.catch(() =>
              Effect.fail(
                new ContainerRuntimeNotFoundError({
                  message: containerRuntimeNotFoundMessage,
                }),
              ),
            ),
          ),
        ),
      );
      // Read stdout concurrently with the exit code: Node's "exit" event can fire before a fast
      // process's stdio finishes draining, so awaiting the exit code first would race the stream.
      const [exitCode, stdout] = yield* Effect.all(
        [handle.exitCode.pipe(Effect.map(Number)), collectText(handle.stdout)],
        { concurrency: "unbounded" },
      );
      return { exitCode, stdout };
    }),
  );

/**
 * Compares two dot-separated version strings numerically, component by component — a naive
 * string/float compare would misorder e.g. `"1.9"` vs `"1.10"`.
 */
function isDockerApiVersionAtLeast(version: string, minVersion: string): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const minParts = minVersion.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(parts.length, minParts.length); index++) {
    const part = parts[index] ?? 0;
    const minPart = minParts[index] ?? 0;
    if (part !== minPart) return part > minPart;
  }
  return true;
}

/**
 * Checks whether the daemon's negotiated API version supports `docker volume prune --all`
 * (added in 1.42). Older daemons reject the flag outright instead of ignoring it, so this must be
 * checked via `docker version` before use; there's no persistent Engine API client to ask
 * directly. Does not fall back to Podman, whose `volume prune` has no `--all` flag to gate.
 * Resolves to `false` on any failure to spawn `docker` or read its version — the same effect as
 * omitting `--all` on a pre-1.42 daemon, which already prunes every unused volume without it.
 */
export const dockerSupportsVolumePruneAllFlag = (spawner: Spawner) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("docker", ["version", "--format", "{{.Server.APIVersion}}"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      const [exitCode, stdout] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), collectText(child.stdout)],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) return false;
      const version = stdout.trim();
      return version.length > 0 && isDockerApiVersionAtLeast(version, "1.42");
    }),
  ).pipe(Effect.orElseSucceed(() => false));
