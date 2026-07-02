import { loadProjectConfig } from "@supabase/config";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Option, Result } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { legacyAqua } from "../../shared/legacy-colors.ts";
import {
  containerCliExitCode,
  legacyDescribeContainerCliFailure,
} from "../../shared/legacy-container-cli.ts";
import {
  legacyCliProjectFilterValue,
  legacyResolveLocalProjectId,
  legacySanitizeProjectId,
} from "../../shared/legacy-docker-ids.ts";
import {
  legacyListContainersByLabel,
  legacyListVolumesByLabel,
} from "../../shared/legacy-docker-lifecycle.ts";
import type { LegacyStopFlags } from "./stop.command.ts";
import {
  LegacyStopConfigLoadError,
  LegacyStopContainerError,
  LegacyStopContainerPruneError,
  LegacyStopListError,
  LegacyStopMutuallyExclusiveError,
  LegacyStopNetworkPruneError,
  LegacyStopVolumePruneError,
} from "./stop.errors.ts";

/**
 * Resolve the Docker label filter `stop` searches on. Go's flag precedence
 * (`stop.go:14-22`): `--all` bypasses config entirely with an empty filter;
 * `--project-id` overrides `Config.ProjectId` directly, also bypassing
 * config.toml; otherwise `flags.LoadConfig` reads config.toml and
 * `Config.ProjectId` (env → toml → workdir basename) is used.
 *
 * The config/env-derived (default) branch is sanitized with
 * {@link legacySanitizeProjectId} before it's used as a filter value,
 * matching Go's `Config.Validate` sanitizing the `Config.ProjectId`
 * singleton once at config-load time (`pkg/config/config.go:938-944`) — every
 * later reader, including the Docker LABEL `start` writes
 * (`internal/utils/docker.go:375`), sees that same sanitized string. The
 * explicit `--project-id` bypass stays RAW to match: Go assigns the flag
 * value straight to `Config.ProjectId` without going through `Validate`
 * (`internal/stop/stop.go:19-20`).
 */
const resolveSearchProjectIdFilter = Effect.fn("legacy.stop.resolveSearchProjectIdFilter")(
  function* (flags: LegacyStopFlags, cliConfig: LegacyCliConfig["Service"]) {
    if (flags.all) return "";
    if (Option.isSome(flags.projectId)) return flags.projectId.value;

    // An absent config.toml is not a failure — Go's `flags.LoadConfig` still
    // resolves a project id via the workdir basename default. Only a
    // malformed file (`loadProjectConfig` failing rather than returning
    // `null`) is a hard error, matching `gen types`'s `loadConfig()` pattern.
    const loaded = yield* loadProjectConfig(cliConfig.workdir).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyStopConfigLoadError({ message: `failed to read config: ${String(cause)}` }),
      ),
    );
    const resolved = legacyResolveLocalProjectId(
      process.env["SUPABASE_PROJECT_ID"],
      loaded?.config.project_id,
      cliConfig.workdir,
    );
    return legacySanitizeProjectId(resolved);
  },
);

export const legacyStop = Effect.fn("legacy.stop")(function* (flags: LegacyStopFlags) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  yield* Effect.gen(function* () {
    if (Option.isSome(flags.projectId) && flags.all) {
      return yield* Effect.fail(
        new LegacyStopMutuallyExclusiveError({
          // Cobra's `validateExclusiveFlagGroups` (spf13/cobra flag_groups.go):
          // the group name keeps declaration order (`strings.Join(flagNames, " ")`),
          // but the "were all set" list is `sort.Strings`-ed — verified against
          // the vendored cobra@v1.10.2 source, not guessed.
          message:
            "if any flags in the group [project-id all] are set none of the others can be; [all project-id] were all set",
        }),
      );
    }

    const searchProjectIdFilter = yield* resolveSearchProjectIdFilter(flags, cliConfig);
    // Go's hidden `--backup` flag is declared via `flags.Bool("backup", true, ...)`
    // (`cmd/stop.go:26`) but its return value is discarded — never bound to a
    // variable, so `RunE` always passes `!noBackup` to `stop.Run` regardless of
    // `--backup`'s value. `--backup=false` is a no-op in the real Go binary
    // today; only `--no-backup` deletes volumes. Matching that exactly (not the
    // seemingly-intended-but-dead semantics of the flag's own description).
    const deleteVolumes = flags.noBackup;
    const filterValue = legacyCliProjectFilterValue(searchProjectIdFilter);

    // Captured (not discarded) so it can be `.fail()`ed or `.clear()`ed below,
    // matching the project's established `output.task` usage pattern
    // (apps/cli/CLAUDE.md's "always wrap API calls in output.task"). In
    // non-interactive/CI runs the spinner never renders, but `.fail()`/`.clear()`
    // still resolve cleanly — a discarded handle would otherwise leave a spinner
    // that's started but never stopped. A single `Effect.tapError` around the
    // whole list/stop/prune sequence (rather than one per step) fails the same
    // task on any error without repeating the same branch at every call site.
    const stopping =
      output.format === "text" ? yield* output.task("Stopping containers...") : undefined;

    yield* Effect.gen(function* () {
      const containerIds = yield* legacyListContainersByLabel(spawner, {
        projectIdFilter: filterValue,
        all: true,
        format: "id",
      }).pipe(Effect.mapError((cause) => new LegacyStopListError({ message: cause.message })));

      // Go stops containers concurrently via `WaitAll`, joining every failure
      // rather than short-circuiting on the first one (`docker.go:96-146`).
      const stopResults = yield* Effect.all(
        containerIds.map((id) => containerCliExitCode(spawner, ["stop", id]).pipe(Effect.result)),
        { concurrency: "unbounded" },
      );
      const failedStop = stopResults.find(
        (result) => Result.isFailure(result) || result.success !== 0,
      );
      if (failedStop !== undefined) {
        return yield* Effect.fail(
          new LegacyStopContainerError({
            message: `failed to stop container: ${
              Result.isFailure(failedStop)
                ? legacyDescribeContainerCliFailure(failedStop.failure)
                : `exit ${failedStop.success}`
            }`,
          }),
        );
      }

      const containerPruneExitCode = yield* containerCliExitCode(spawner, [
        "container",
        "prune",
        "--force",
        "--filter",
        `label=${filterValue}`,
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyStopContainerPruneError({
              message: `failed to prune containers: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      if (containerPruneExitCode !== 0) {
        return yield* Effect.fail(
          new LegacyStopContainerPruneError({ message: "failed to prune containers" }),
        );
      }

      if (deleteVolumes) {
        // Go gates the `--all` filter arg on Docker engine >= 1.42 (`docker.go:120-124`).
        // All currently supported Docker versions are well past 1.42, so the TS port
        // always passes `--all` — documented divergence, see SIDE_EFFECTS.md Notes.
        const volumePruneExitCode = yield* containerCliExitCode(spawner, [
          "volume",
          "prune",
          "--force",
          "--all",
          "--filter",
          `label=${filterValue}`,
        ]).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyStopVolumePruneError({
                message: `failed to prune volumes: ${legacyDescribeContainerCliFailure(cause)}`,
              }),
          ),
        );
        if (volumePruneExitCode !== 0) {
          return yield* Effect.fail(
            new LegacyStopVolumePruneError({ message: "failed to prune volumes" }),
          );
        }
      }

      const networkPruneExitCode = yield* containerCliExitCode(spawner, [
        "network",
        "prune",
        "--force",
        "--filter",
        `label=${filterValue}`,
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyStopNetworkPruneError({
              message: `failed to prune networks: ${legacyDescribeContainerCliFailure(cause)}`,
            }),
        ),
      );
      if (networkPruneExitCode !== 0) {
        return yield* Effect.fail(
          new LegacyStopNetworkPruneError({ message: "failed to prune networks" }),
        );
      }
    }).pipe(Effect.tapError(() => stopping?.fail() ?? Effect.void));

    yield* stopping?.clear() ?? Effect.void;

    if (output.format === "text") {
      // Written to stdout (no stream arg): `legacyAqua` must target stdout's own
      // TTY status, not stderr's — see `legacy-colors.ts`'s doc comment.
      yield* output.raw(
        `Stopped ${legacyAqua("supabase", process.stdout)} local development setup.\n`,
      );
    } else {
      yield* output.success("Stopped supabase local development setup.", {
        project_id_filter: searchProjectIdFilter,
        backup: !deleteVolumes,
      });
    }

    // Post-run suggestion (stop.go:26-37): only meaningful in text mode — json/
    // stream-json payloads have no equivalent field to carry this hint.
    if (output.format === "text") {
      const remainingVolumes = yield* legacyListVolumesByLabel(spawner, filterValue).pipe(
        Effect.orElseSucceed(() => []),
      );
      if (remainingVolumes.length > 0) {
        const listVolumeCommand =
          searchProjectIdFilter.length > 0
            ? `docker volume ls --filter label=com.supabase.cli.project=${searchProjectIdFilter}`
            : "docker volume ls --filter label=com.supabase.cli.project";
        yield* output.raw(
          `Local data are backed up to docker volume. Use docker to show them: ${legacyAqua(listVolumeCommand)}\n`,
          "stderr",
        );
      }
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
