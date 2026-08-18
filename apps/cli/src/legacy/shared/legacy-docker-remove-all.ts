import { Data, Effect, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import {
  containerCliExitCode,
  legacyContainerCliExitCodeAndStdout,
  legacyDescribeContainerCliFailure,
  legacyDockerSupportsVolumePruneAllFlag,
} from "./legacy-container-cli.ts";
import {
  legacyListContainerIdsAndNames,
  type LegacyContainerIdName,
} from "./legacy-docker-lifecycle.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * Failure taxonomy for {@link legacyDockerRemoveAll}. Each variant is a neutral, stage-tagged
 * cause carrying only a `.message` — same generalization pattern as `legacy-docker-lifecycle.ts`'s
 * `LegacyDockerLifecycleListError`/`LegacyDockerLifecycleInspectError`. Callers (`stop.handler.ts`
 * via `Effect.catchTags`; `legacy/shared/db-bootstrap/rollback.ts` via a blanket swallow) discriminate/consume these by
 * their string `_tag`, never by importing the classes themselves. The classes
 * are exported so the exhaustive telemetry guard can verify their declarations.
 */
export class LegacyDockerRemoveAllListError extends Data.TaggedError(
  "LegacyDockerRemoveAllListError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

export class LegacyDockerRemoveAllStopError extends Data.TaggedError(
  "LegacyDockerRemoveAllStopError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

export class LegacyDockerRemoveAllContainerPruneError extends Data.TaggedError(
  "LegacyDockerRemoveAllContainerPruneError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

export class LegacyDockerRemoveAllVolumePruneError extends Data.TaggedError(
  "LegacyDockerRemoveAllVolumePruneError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

export class LegacyDockerRemoveAllNetworkPruneError extends Data.TaggedError(
  "LegacyDockerRemoveAllNetworkPruneError",
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
 * `--debug` prune reports: `fmt.Fprintln(os.Stderr,
 * "Pruned containers:", report.ContainersDeleted)` and siblings — the `[]string`
 * renders as `[a b c]` (empty: `[]`), always on stderr regardless of the writer
 * the caller passed, and only when `viper.GetBool("DEBUG")` is set.
 */
const reportPruned = (debug: boolean, label: string, stdout: string) =>
  Effect.sync(() => {
    if (!debug) return;
    globalThis.process.stderr.write(`${label} [${parsePrunedNames(stdout).join(" ")}]\n`);
  });

/** Every failure {@link legacyDockerRemoveAll} can produce. */
export type LegacyDockerRemoveAllError =
  | LegacyDockerRemoveAllListError
  | LegacyDockerRemoveAllStopError
  | LegacyDockerRemoveAllContainerPruneError
  | LegacyDockerRemoveAllVolumePruneError
  | LegacyDockerRemoveAllNetworkPruneError;

/**
 * Port of `DockerRemoveAll`: list every
 * container matching `filterValue` regardless of state -> stop them all concurrently, joining
 * every failure rather than short-circuiting on the first one (`WaitAll`) -> `container
 * prune --force --filter label=<filterValue>` -> when `deleteVolumes`, `volume prune --force
 * [--all] --filter label=<filterValue>` (the `--all` flag itself gated on
 * {@link legacyDockerSupportsVolumePruneAllFlag}, Docker API >= 1.42) -> `network prune --force
 * --filter label=<filterValue>`.
 *
 * `onContainersRemoved`, if given, fires synchronously once `container prune` (the actual
 * removal step below) has EXITED SUCCESSFULLY — not at the initial listing, and not before
 * containers are even stopped — with the exact containers that listing found, id/name/workdir
 * together. A TS-port-only hook with no Go equivalent, for callers (`stop.handler.ts`,
 * `legacy/shared/db-bootstrap/rollback.ts`) that need those same containers for {@link legacyCleanupStartSecrets}
 * (Go itself doesn't stage host-disk secrets, so it has no reason to know them). It exists so
 * those callers get this data from THIS function's own single `docker ps` listing instead of
 * issuing a second, separately-formatted `docker ps` call, which would double the real Docker
 * Engine API request count relative to Go and fail the cli-e2e-ci request-log parity check.
 *
 * Firing AFTER `container prune` succeeds (rather than at listing time) matters: the listing
 * only snapshots what MIGHT be torn down, before the stop/prune stages have actually run — firing
 * there let a caller reclaim a container's staged-secret directory even when the stop stage fails
 * outright (so `container prune` never even runs and nothing was actually removed) or a
 * still-running container survives. Firing here instead means a caller only ever reclaims
 * secrets for containers `container prune` has ACTUALLY removed. It still fires even if a LATER
 * stage (volume/network prune) then fails, so those confirmed-removed containers' secrets are
 * still reclaimed on that partial failure — matching the fix landed in `983eab92`.
 */
export const legacyDockerRemoveAll = (
  spawner: Spawner,
  filterValue: string,
  deleteVolumes: boolean,
  onContainersRemoved?: (containers: ReadonlyArray<LegacyContainerIdName>) => void,
  debug = false,
): Effect.Effect<void, LegacyDockerRemoveAllError> =>
  Effect.gen(function* () {
    const containers = yield* legacyListContainerIdsAndNames(spawner, {
      projectIdFilter: filterValue,
      all: true,
    }).pipe(
      Effect.mapError((cause) => new LegacyDockerRemoveAllListError({ message: cause.message })),
    );
    const containerIds = containers.map((container) => container.id);

    // Go stops containers concurrently via `WaitAll`, joining every failure rather than
    // short-circuiting on the first one.
    //
    // `stdout`/`stderr: "ignore"` on the exit-code-only `stop` calls below: they never read the
    // child's own output, and the default `"pipe"` stdio otherwise leaves an OS pipe unread —
    // once `docker`/`podman` write enough to it, the child blocks on write() and this hangs.
    // Matches the existing `stdio: "ignore"` precedent for the same "exit-code-only" shape in
    // `legacy-pgdelta.seam.layer.ts`. The prune calls further down instead COLLECT stdout (via
    // `legacyContainerCliExitCodeAndStdout`, which reads the pipe, equally avoiding the hang)
    // because their deleted-ID reports back `--debug` `Pruned …:` stderr lines.
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

    // The prune calls collect stdout (the CLI's deleted-ID report) instead of
    // ignoring it — reading the pipe equally avoids the unread-pipe hang the
    // exit-code-only calls above dodge with `stdout: "ignore"`, and the report
    // backs `--debug` `Pruned …:` stderr lines.
    const containerPrune = yield* legacyContainerCliExitCodeAndStdout(spawner, [
      "container",
      "prune",
      "--force",
      "--filter",
      `label=${filterValue}`,
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDockerRemoveAllContainerPruneError({
            message: `failed to prune containers: ${legacyDescribeContainerCliFailure(cause)}`,
          }),
      ),
    );
    if (containerPrune.exitCode !== 0) {
      return yield* Effect.fail(
        new LegacyDockerRemoveAllContainerPruneError({ message: "failed to prune containers" }),
      );
    }
    yield* reportPruned(debug, "Pruned containers:", containerPrune.stdout);
    // Containers are now CONFIRMED removed — see `onContainersRemoved`'s doc comment for why this
    // must fire here rather than at the listing above, and why it still must fire even if a later
    // stage (volume/network prune, below) goes on to fail.
    onContainersRemoved?.(containers);

    if (deleteVolumes) {
      // The `--all` filter arg is gated on Docker API >= 1.42: Docker CLI's own `volume
      // prune --all` flag is annotated `version: "1.42"` and enforced by
      // its own arg validator before the command runs —
      // on an older daemon, passing `--all` unconditionally
      // would hard-fail this whole call and prune nothing, not just prune a narrower set. There's
      // no persistent Engine API client here to ask the negotiated version directly, so
      // {@link legacyDockerSupportsVolumePruneAllFlag} asks the `docker` CLI itself via `docker
      // version` and applies the same gate.
      //
      // Podman is a Docker-CLI-compatible fallback — but `--all` isn't a real flag on any
      // released Podman `volume prune` (only `--filter`/`--force`/`--help`, checked v4.3 through
      // the current v5.7; `--all` only exists in unreleased dev docs), so it hard-fails on a real
      // Podman-only host. Podman already prunes every unused volume by default, so omitting
      // `--all` on the Podman fallback is a lossless fix.
      const dockerSupportsAll = yield* legacyDockerSupportsVolumePruneAllFlag(spawner);
      const volumePrune = yield* legacyContainerCliExitCodeAndStdout(
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
            new LegacyDockerRemoveAllVolumePruneError({
              message: `failed to prune volumes: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      if (volumePrune.exitCode !== 0) {
        return yield* Effect.fail(
          new LegacyDockerRemoveAllVolumePruneError({ message: "failed to prune volumes" }),
        );
      }
      // Inside the `deleteVolumes` branch, like Go's report inside the
      // `NoBackupVolume` block.
      yield* reportPruned(debug, "Pruned volumes:", volumePrune.stdout);
    }

    const networkPrune = yield* legacyContainerCliExitCodeAndStdout(spawner, [
      "network",
      "prune",
      "--force",
      "--filter",
      `label=${filterValue}`,
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDockerRemoveAllNetworkPruneError({
            message: `failed to prune networks: ${legacyDescribeContainerCliFailure(cause)}`,
          }),
      ),
    );
    if (networkPrune.exitCode !== 0) {
      return yield* Effect.fail(
        new LegacyDockerRemoveAllNetworkPruneError({ message: "failed to prune networks" }),
      );
    }
    // Go: singular "network", unlike the other two reports.
    yield* reportPruned(debug, "Pruned network:", networkPrune.stdout);
  });
