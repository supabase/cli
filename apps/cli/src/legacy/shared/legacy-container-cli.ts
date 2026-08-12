import { Data, Effect, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

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
 * Callers never need to match on this type directly, they fold it into their
 * own tagged error via {@link legacyDescribeContainerCliFailure} so the "no
 * runtime found" root cause survives instead of collapsing into a generic
 * "failed to ..." message. Exported only so the coverage test can verify its
 * own actionability declaration.
 */
export class LegacyContainerRuntimeNotFoundError extends Data.TaggedError(
  "LegacyContainerRuntimeNotFoundError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/**
 * Exported so `legacy-docker-suggest.ts`'s daemon-unreachable matcher can test
 * against this literal directly instead of a hardcoded copy of the substring —
 * keeping the producer and the classifier from drifting apart if this ever gets
 * reworded.
 */
export const legacyContainerRuntimeNotFoundMessage =
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

/** Which of the two supported container CLIs actually answered a spawn. */
export type LegacyContainerRuntime = "docker" | "podman";

/**
 * {@link spawnContainerCli}, but also reporting which runtime answered — for
 * callers that print a command for the user to run themselves, where naming
 * `docker` on a Podman-only host would be uncopyable advice.
 */
export const legacySpawnContainerCliWithRuntime = (
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
            new LegacyContainerRuntimeNotFoundError({
              message: legacyContainerRuntimeNotFoundMessage,
            }),
          ),
        ),
      ),
    ),
  );

const dockerRuntime: LegacyContainerRuntime = "docker";
const podmanRuntime: LegacyContainerRuntime = "podman";

/**
 * Spawn a container-CLI command and return the process handle. Use when the
 * caller needs to read stdout/stderr or await the exit code itself.
 */
export const spawnContainerCli = (
  spawner: Spawner,
  args: ReadonlyArray<string>,
  options?: ChildProcess.CommandOptions,
) => legacySpawnContainerCliWithRuntime(spawner, args, options).pipe(Effect.map((it) => it.handle));

/**
 * Run a container-CLI command and resolve to its exit code, mirroring the
 * spawner's `exitCode` convenience for callers that only need the status.
 *
 * `podmanArgs` lets a caller pass different argv to the Podman fallback than to
 * Docker, for the rare case where the two aren't drop-in compatible on a given
 * subcommand (e.g. `volume prune --all` — Docker-only, see
 * `stop.handler.ts`'s volume-prune call). Defaults to reusing `args` unchanged,
 * which is correct for every other call site.
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
            new LegacyContainerRuntimeNotFoundError({
              message: legacyContainerRuntimeNotFoundMessage,
            }),
          ),
        ),
      ),
    ),
  );

/**
 * Folds a byte stream into a decoded string. Hoisted here (the shared home for
 * container-CLI plumbing) so `container-lifecycle.ts`/`restart-services.ts`/
 * `legacy-docker-lifecycle.ts` — every module that spawns `docker`/`podman` and
 * needs its stdout/stderr as text — stop each defining their own copy.
 */
export function legacyCollectText(stream: Stream.Stream<Uint8Array, unknown>) {
  const decoder = new TextDecoder();
  return Stream.runFold(
    stream,
    () => "",
    (text, chunk) => text + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.map((text) => text + decoder.decode()));
}

/**
 * Docker's/Podman's "container doesn't exist" stderr shapes for `container inspect` — Docker's
 * "No such container"/"No such object" (either casing depending on daemon version/CLI path) or
 * Podman's own differently worded "no container with name or ID ... found: no such container" —
 * the subprocess equivalent of `errdefs.IsNotFound` for a CLI-shelled-out (rather than
 * Engine-API) caller. Case-insensitive and covers all three shapes so a lowercase Podman message
 * is tolerated exactly like an uppercase Docker one — the same distinction
 * `legacy-docker-image-resolve.ts`'s `isImageNotFoundMessage` draws for `image inspect`, and the
 * same distinction the pre-existing Podman-aware parser in `commands/start/start.handler.ts`'s
 * own (now-removed) local `isContainerNotFoundMessage` used to draw. Hoisted here (rather than
 * left as separate per-caller copies) so every container-not-found check across the
 * container-lifecycle/start/restart/health-check domain (`legacyIsLocalDbRunning`,
 * `legacyRestartSatelliteService`, `legacyReloadKong`, …) shares one predicate instead of
 * re-deriving the same match with different Podman coverage — a reset excluding a satellite
 * service (storage/auth/realtime/pooler) or Kong would otherwise report a hard restart/reload
 * failure instead of tolerating the absent container.
 */
export function legacyIsContainerNotFoundMessage(message: string): boolean {
  return (
    /no such container/iu.test(message) ||
    /no such object/iu.test(message) ||
    /no container with name or id/iu.test(message)
  );
}

/**
 * Runs a container-CLI command that must succeed outright — no tolerance for any
 * failure mode (spawn failure, non-zero exit) — the shared shape behind every
 * "docker verb target" primitive that fails hard on any problem
 * (`legacyRemoveContainer`/`legacyRemoveVolume`/`legacyRestartContainer`; see
 * `db-bootstrap/container-lifecycle.ts` and `db-bootstrap/restart-services.ts`).
 * `verb` is the human-readable action embedded in the error message (e.g.
 * `"remove container"` → `"failed to remove container: <cause>"`).
 */
export function legacyRunContainerCliExpectSuccess<E>(
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
          makeError(`failed to ${verb}: ${legacyDescribeContainerCliFailure(cause)}`),
        ),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stderr)],
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
 * Like {@link containerCliExitCode}, but also collecting the child's stdout —
 * for callers that need the CLI's own report of what it did (e.g. the `docker
 * … prune` deleted-ID lists backing `--debug` "Pruned …" reports in
 * `DockerRemoveAll`, `docker.go:123-143`). Collecting (i.e. reading) stdout
 * also sidesteps the unread-pipe hang that `stdout: "ignore"` callers avoid by
 * discarding it. stderr is discarded, matching the exit-code-only helper.
 * `podmanArgs` has the same meaning as on {@link containerCliExitCode}.
 */
export const legacyContainerCliExitCodeAndStdout = (
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
                new LegacyContainerRuntimeNotFoundError({
                  message: legacyContainerRuntimeNotFoundMessage,
                }),
              ),
            ),
          ),
        ),
      );
      // Subscribe to stdout concurrently with awaiting the exit code — Node's
      // "exit" event can fire before a fast process's stdio pipes are drained,
      // so a late subscriber would see an already-ended, empty stream (same
      // pattern as `legacy-docker-lifecycle.ts`'s `spawnDockerPsLines`).
      const [exitCode, stdout] = yield* Effect.all(
        [handle.exitCode.pipe(Effect.map(Number)), legacyCollectText(handle.stdout)],
        { concurrency: "unbounded" },
      );
      return { exitCode, stdout };
    }),
  );

/**
 * Mirrors `versions.GreaterThanOrEqualTo` (`docker/api/types/versions`,
 * used by `apps/cli-go/internal/utils/docker.go:128`): splits each version on
 * `.` and compares the parts numerically, component by component — not a
 * naive string/float compare, which would misorder e.g. `"1.9"` vs `"1.10"`.
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
 * Docker CLI's own `volume prune --all` flag is annotated `version: "1.42"`
 * (vendored `docker/cli@v28.5.2` `cli/command/volume/prune.go:53`) and
 * enforced by Cobra's `Args` validator *before* `RunE` runs:
 * against a daemon with a lower negotiated
 * API version, `docker volume prune --all ...` exits nonzero without pruning
 * anything at all, rather than degrading gracefully. Go avoids ever hitting
 * that by gating the equivalent `all=true` filter on
 * `Docker.ClientVersion() >= "1.42"`; there is no
 * persistent Engine API client here to ask, so this asks the `docker` CLI
 * itself via `docker version`.
 *
 * Deliberately does not fall back to Podman like {@link containerCliExitCode}
 * does: Podman's `volume prune` never has an `--all` flag to gate in the
 * first place (callers already omit it from their Podman argv
 * unconditionally), so this check is meaningless on that path. Resolves to
 * `false` (omit `--all`, matching how a pre-1.42 daemon's own `volume prune`
 * already prunes every unused volume without it) whenever `docker` can't be
 * spawned, its `version` call fails, or the reported version can't be read —
 * the side that can never turn into a hard failure of the prune call itself.
 */
export const legacyDockerSupportsVolumePruneAllFlag = (spawner: Spawner) =>
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
        [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stdout)],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) return false;
      const version = stdout.trim();
      return version.length > 0 && isDockerApiVersionAtLeast(version, "1.42");
    }),
  ).pipe(Effect.orElseSucceed(() => false));
