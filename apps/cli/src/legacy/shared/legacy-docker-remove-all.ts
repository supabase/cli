import { Data, Effect, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  containerCliExitCode,
  legacyDescribeContainerCliFailure,
  legacyDockerSupportsVolumePruneAllFlag,
} from "./legacy-container-cli.ts";
import { legacyListContainersByLabel } from "./legacy-docker-lifecycle.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * Failure taxonomy for {@link legacyDockerRemoveAll}. Each variant is a neutral, stage-tagged
 * cause carrying only a `.message` — same generalization pattern as `legacy-docker-lifecycle.ts`'s
 * `LegacyDockerLifecycleListError`/`LegacyDockerLifecycleInspectError`. Callers (`stop.handler.ts`
 * via `Effect.catchTags`; `start.rollback.ts` via a blanket swallow) discriminate/consume these by
 * their string `_tag`, never by importing the classes themselves, so only the union below is
 * exported — matching every constructor's actual usage (confirmed via `knip`).
 */
class LegacyDockerRemoveAllListError extends Data.TaggedError("LegacyDockerRemoveAllListError")<{
  readonly message: string;
}> {}

class LegacyDockerRemoveAllStopError extends Data.TaggedError("LegacyDockerRemoveAllStopError")<{
  readonly message: string;
}> {}

class LegacyDockerRemoveAllContainerPruneError extends Data.TaggedError(
  "LegacyDockerRemoveAllContainerPruneError",
)<{
  readonly message: string;
}> {}

class LegacyDockerRemoveAllVolumePruneError extends Data.TaggedError(
  "LegacyDockerRemoveAllVolumePruneError",
)<{
  readonly message: string;
}> {}

class LegacyDockerRemoveAllNetworkPruneError extends Data.TaggedError(
  "LegacyDockerRemoveAllNetworkPruneError",
)<{
  readonly message: string;
}> {}

/** Every failure {@link legacyDockerRemoveAll} can produce. */
export type LegacyDockerRemoveAllError =
  | LegacyDockerRemoveAllListError
  | LegacyDockerRemoveAllStopError
  | LegacyDockerRemoveAllContainerPruneError
  | LegacyDockerRemoveAllVolumePruneError
  | LegacyDockerRemoveAllNetworkPruneError;

/**
 * Port of Go's `DockerRemoveAll` (`apps/cli-go/internal/utils/docker.go:96-146`): list every
 * container matching `filterValue` regardless of state -> stop them all concurrently, joining
 * every failure rather than short-circuiting on the first one (Go's `WaitAll`) -> `container
 * prune --force --filter label=<filterValue>` -> when `deleteVolumes`, `volume prune --force
 * [--all] --filter label=<filterValue>` (the `--all` flag itself gated on
 * {@link legacyDockerSupportsVolumePruneAllFlag}, Docker API >= 1.42) -> `network prune --force
 * --filter label=<filterValue>`.
 */
export const legacyDockerRemoveAll = (
  spawner: Spawner,
  filterValue: string,
  deleteVolumes: boolean,
): Effect.Effect<void, LegacyDockerRemoveAllError> =>
  Effect.gen(function* () {
    const containerIds = yield* legacyListContainersByLabel(spawner, {
      projectIdFilter: filterValue,
      all: true,
      format: "id",
    }).pipe(
      Effect.mapError((cause) => new LegacyDockerRemoveAllListError({ message: cause.message })),
    );

    // Go stops containers concurrently via `WaitAll`, joining every failure rather than
    // short-circuiting on the first one (`docker.go:96-146`).
    //
    // `stdout`/`stderr: "ignore"` on every exit-code-only call below: none of these read the
    // child's own output, and the default `"pipe"` stdio otherwise leaves an OS pipe unread —
    // once `docker`/`podman` write enough to it (e.g. `container prune`'s "Deleted Containers"
    // ID list on a host with many stale containers, most likely under `stop --all`), the child
    // blocks on write() and this hangs. Matches the existing `stdio: "ignore"` precedent for the
    // same "exit-code-only" shape in `legacy-pgdelta.seam.layer.ts`.
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
        new LegacyDockerRemoveAllStopError({
          message: `failed to stop container: ${
            Result.isFailure(failedStop)
              ? legacyDescribeContainerCliFailure(failedStop.failure)
              : `exit ${failedStop.success}`
          }`,
        }),
      );
    }

    const containerPruneExitCode = yield* containerCliExitCode(
      spawner,
      ["container", "prune", "--force", "--filter", `label=${filterValue}`],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDockerRemoveAllContainerPruneError({
            message: `failed to prune containers: ${legacyDescribeContainerCliFailure(cause)}`,
          }),
      ),
    );
    if (containerPruneExitCode !== 0) {
      return yield* Effect.fail(
        new LegacyDockerRemoveAllContainerPruneError({ message: "failed to prune containers" }),
      );
    }

    if (deleteVolumes) {
      // Go gates the `--all` filter arg on Docker API >= 1.42 (`docker.go:126-133`,
      // `Docker.ClientVersion() >= "1.42"`): Docker CLI's own `volume prune --all` flag is
      // annotated `version: "1.42"` (`docker/cli@v28.5.2` `cli/command/volume/prune.go:53`) and
      // enforced by Cobra's `Args` validator *before* `RunE` runs
      // (`cmd/docker/docker.go:659-660`) — on an older daemon, passing `--all` unconditionally
      // would hard-fail this whole call and prune nothing, not just prune a narrower set. There's
      // no persistent Engine API client here to ask the negotiated version directly (Go talks to
      // the Docker Engine API, never a `docker` binary), so
      // {@link legacyDockerSupportsVolumePruneAllFlag} asks the `docker` CLI itself via `docker
      // version` and mirrors Go's gate exactly.
      //
      // Podman is a Docker-CLI-compatible fallback this port adds, not something Go itself has,
      // so there's no Go behavior to match on that path — but `--all` isn't a real flag on any
      // released Podman `volume prune` (only `--filter`/`--force`/`--help`, checked v4.3 through
      // the current v5.7; `--all` only exists in unreleased dev docs), so it hard-fails on a real
      // Podman-only host. Podman already prunes every unused volume by default, so omitting
      // `--all` on the Podman fallback is a lossless fix.
      const dockerSupportsAll = yield* legacyDockerSupportsVolumePruneAllFlag(spawner);
      const volumePruneExitCode = yield* containerCliExitCode(
        spawner,
        [
          "volume",
          "prune",
          "--force",
          ...(dockerSupportsAll ? ["--all"] : []),
          "--filter",
          `label=${filterValue}`,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        ["volume", "prune", "--force", "--filter", `label=${filterValue}`],
      ).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyDockerRemoveAllVolumePruneError({
              message: `failed to prune volumes: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      if (volumePruneExitCode !== 0) {
        return yield* Effect.fail(
          new LegacyDockerRemoveAllVolumePruneError({ message: "failed to prune volumes" }),
        );
      }
    }

    const networkPruneExitCode = yield* containerCliExitCode(
      spawner,
      ["network", "prune", "--force", "--filter", `label=${filterValue}`],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDockerRemoveAllNetworkPruneError({
            message: `failed to prune networks: ${legacyDescribeContainerCliFailure(cause)}`,
          }),
      ),
    );
    if (networkPruneExitCode !== 0) {
      return yield* Effect.fail(
        new LegacyDockerRemoveAllNetworkPruneError({ message: "failed to prune networks" }),
      );
    }
  });
