import { Data, Effect, Stream } from "effect";
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
  spawner
    .exitCode(ChildProcess.make("docker", args, options))
    .pipe(
      Effect.catch(() =>
        spawner
          .exitCode(ChildProcess.make("podman", podmanArgs ?? args, options))
          .pipe(
            Effect.catch(() =>
              Effect.fail(
                new LegacyContainerRuntimeNotFoundError({ message: RUNTIME_NOT_FOUND_MESSAGE }),
              ),
            ),
          ),
      ),
    );

function collectDockerCliText(stream: Stream.Stream<Uint8Array, unknown>) {
  const decoder = new TextDecoder();
  return Stream.runFold(
    stream,
    () => "",
    (text, chunk) => text + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.map((text) => text + decoder.decode()));
}

/**
 * Mirrors Go's `versions.GreaterThanOrEqualTo` (`docker/api/types/versions`,
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
 * enforced by Cobra's `Args` validator *before* `RunE` runs
 * (`cmd/docker/docker.go:659-660`): against a daemon with a lower negotiated
 * API version, `docker volume prune --all ...` exits nonzero without pruning
 * anything at all, rather than degrading gracefully. Go avoids ever hitting
 * that by gating the equivalent `all=true` filter on
 * `Docker.ClientVersion() >= "1.42"` (`docker.go:126-133`); there is no
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
        [child.exitCode.pipe(Effect.map(Number)), collectDockerCliText(child.stdout)],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) return false;
      const version = stdout.trim();
      return version.length > 0 && isDockerApiVersionAtLeast(version, "1.42");
    }),
  ).pipe(Effect.orElseSucceed(() => false));
