import { Data, Effect, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import {
  containerCliExitCode,
  containerCliExitCodeAndStdout,
  describeContainerCliFailure,
  dockerSupportsVolumePruneAllFlag,
} from "./container-cli.ts";
import { listContainerIdsAndNames, type ContainerIdName } from "./docker-lifecycle.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * Failure taxonomy for {@link dockerRemoveAll}. Callers discriminate these by their string
 * `_tag` rather than importing the classes; they're exported only so the exhaustive telemetry
 * guard can verify each declaration.
 */
class DockerRemoveAllListError extends Data.TaggedError("DockerRemoveAllListError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

class DockerRemoveAllStopError extends Data.TaggedError("DockerRemoveAllStopError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

class DockerRemoveAllContainerPruneError extends Data.TaggedError(
  "DockerRemoveAllContainerPruneError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

class DockerRemoveAllVolumePruneError extends Data.TaggedError("DockerRemoveAllVolumePruneError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

class DockerRemoveAllNetworkPruneError extends Data.TaggedError(
  "DockerRemoveAllNetworkPruneError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/**
 * Extracts the deleted-object IDs/names from `docker`/`podman` `… prune`
 * stdout. Docker prints a `Deleted Containers:`/`Deleted Volumes:`/`Deleted
 * Networks:` header, one ID/name per line, then a `Total reclaimed space: …`
 * summary; Podman prints the bare IDs/names only. Keep the bare-value lines,
 * dropping headers and the summary.
 */
function parsePrunedNames(stdout: string): ReadonlyArray<string> {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) => line.length > 0 && !line.endsWith(":") && !line.startsWith("Total reclaimed space"),
    );
}

/**
 * Prints a `--debug`-only report of pruned names to stderr, formatted as a bracketed
 * space-separated list (e.g. `[a b c]`, empty: `[]`).
 */
const reportPruned = (debug: boolean, label: string, stdout: string) =>
  Effect.sync(() => {
    if (!debug) return;
    globalThis.process.stderr.write(`${label} [${parsePrunedNames(stdout).join(" ")}]\n`);
  });

/** Every failure {@link dockerRemoveAll} can produce. */
export type DockerRemoveAllError =
  | DockerRemoveAllListError
  | DockerRemoveAllStopError
  | DockerRemoveAllContainerPruneError
  | DockerRemoveAllVolumePruneError
  | DockerRemoveAllNetworkPruneError;

/**
 * Lists every container matching `filterValue` (any state), stops them all concurrently —
 * joining every failure rather than stopping at the first — then prunes containers, volumes
 * (when `deleteVolumes`), and networks scoped to the same label. `onContainersRemoved`, when
 * given, fires once `container prune` exits successfully with the containers the initial listing
 * found, so callers don't have to re-list; it still fires even if a later prune stage fails.
 */
export const dockerRemoveAll = (
  spawner: Spawner,
  filterValue: string,
  deleteVolumes: boolean,
  onContainersRemoved?: (containers: ReadonlyArray<ContainerIdName>) => void,
  debug = false,
): Effect.Effect<void, DockerRemoveAllError> =>
  Effect.gen(function* () {
    const containers = yield* listContainerIdsAndNames(spawner, {
      projectIdFilter: filterValue,
      all: true,
    }).pipe(Effect.mapError((cause) => new DockerRemoveAllListError({ message: cause.message })));
    const containerIds = containers.map((container) => container.id);

    // Stop every container concurrently, joining every failure rather than short-circuiting on
    // the first one.
    //
    // `stdout`/`stderr: "ignore"`: these exit-code-only calls never read the child's output, and
    // the default `"pipe"` stdio would leave an unread OS pipe — once docker/podman writes enough
    // to it, the child blocks on write() and this hangs. The prune calls below instead collect
    // stdout (avoiding the hang the same way) because they need it for the `--debug` report.
    const stopResults = yield* Effect.all(
      containerIds.map((id) =>
        containerCliExitCode(spawner, ["stop", id], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }).pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    const failedStop = stopResults.find(
      (result) => Result.isFailure(result) || result.success !== 0,
    );
    if (failedStop !== undefined) {
      return yield* Effect.fail(
        new DockerRemoveAllStopError({
          message: `failed to stop container: ${
            Result.isFailure(failedStop)
              ? describeContainerCliFailure(failedStop.failure)
              : `exit ${failedStop.success}`
          }`,
        }),
      );
    }

    // Collects stdout instead of ignoring it — reading the pipe avoids the same hang, and the
    // report backs the `--debug` output below.
    const containerPrune = yield* containerCliExitCodeAndStdout(spawner, [
      "container",
      "prune",
      "--force",
      "--filter",
      `label=${filterValue}`,
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new DockerRemoveAllContainerPruneError({
            message: `failed to prune containers: ${describeContainerCliFailure(cause)}`,
          }),
      ),
    );
    if (containerPrune.exitCode !== 0) {
      return yield* Effect.fail(
        new DockerRemoveAllContainerPruneError({ message: "failed to prune containers" }),
      );
    }
    yield* reportPruned(debug, "Pruned containers:", containerPrune.stdout);
    // Containers are confirmed removed only now — see {@link dockerRemoveAll}'s doc comment.
    onContainersRemoved?.(containers);

    if (deleteVolumes) {
      // `--all` requires Docker API >= 1.42 and is validated by the Docker CLI itself, so passing
      // it unconditionally would hard-fail on an older daemon; ask `docker version` via
      // {@link dockerSupportsVolumePruneAllFlag} instead of negotiating the API version directly.
      // Podman has no `--all` flag on `volume prune` at all, but already prunes every unused
      // volume by default, so omitting `--all` there is a lossless fallback.
      const dockerSupportsAll = yield* dockerSupportsVolumePruneAllFlag(spawner);
      const volumePrune = yield* containerCliExitCodeAndStdout(
        spawner,
        [
          "volume",
          "prune",
          "--force",
          ...(dockerSupportsAll ? ["--all"] : []),
          "--filter",
          `label=${filterValue}`,
        ],
        ["volume", "prune", "--force", "--filter", `label=${filterValue}`],
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DockerRemoveAllVolumePruneError({
              message: `failed to prune volumes: ${describeContainerCliFailure(cause)}`,
            }),
        ),
      );
      if (volumePrune.exitCode !== 0) {
        return yield* Effect.fail(
          new DockerRemoveAllVolumePruneError({ message: "failed to prune volumes" }),
        );
      }
      yield* reportPruned(debug, "Pruned volumes:", volumePrune.stdout);
    }

    const networkPrune = yield* containerCliExitCodeAndStdout(spawner, [
      "network",
      "prune",
      "--force",
      "--filter",
      `label=${filterValue}`,
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new DockerRemoveAllNetworkPruneError({
            message: `failed to prune networks: ${describeContainerCliFailure(cause)}`,
          }),
      ),
    );
    if (networkPrune.exitCode !== 0) {
      return yield* Effect.fail(
        new DockerRemoveAllNetworkPruneError({ message: "failed to prune networks" }),
      );
    }
    // Established output text: singular "network", unlike the container/volume reports.
    yield* reportPruned(debug, "Pruned network:", networkPrune.stdout);
  });
