import { Effect, FileSystem, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { Output } from "../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { legacyAqua } from "../../shared/legacy-colors.ts";
import { legacyCliProjectFilterValue } from "../../shared/legacy-docker-ids.ts";
import { legacyListVolumesByLabel } from "../../shared/legacy-docker-lifecycle.ts";
import { legacyDockerRemoveAll } from "../../shared/legacy-docker-remove-all.ts";
import { legacyResolveLocalConfigValues } from "../../shared/legacy-local-config-values.ts";
import { legacyLoadLocalProjectContext } from "../../shared/legacy-local-project-context.ts";
import { legacyValidateWorkdirIsDirectory } from "../../shared/legacy-workdir-validation.ts";
import type { LegacyStopFlags } from "./stop.command.ts";
import {
  LegacyStopConfigLoadError,
  LegacyStopContainerError,
  LegacyStopContainerPruneError,
  LegacyStopListError,
  LegacyStopMutuallyExclusiveError,
  LegacyStopNetworkPruneError,
  LegacyStopVolumePruneError,
  LegacyStopWorkdirError,
} from "./stop.errors.ts";

/**
 * Resolve the Docker label filter `stop` searches on. Go's flag precedence
 * (`stop.go:14-22`): `--all` bypasses config entirely with an empty filter;
 * `--project-id` overrides `Config.ProjectId` directly, also bypassing
 * config.toml; otherwise `flags.LoadConfig` reads config.toml and
 * `Config.ProjectId` (env → toml → workdir basename) is used.
 *
 * "env" is Go's post-`loadNestedEnv` value, not just the ambient shell
 * environment: `Config.Load` loads `supabase/.env`/`.env.local` *and*
 * project-root/`SUPABASE_ENV`-selected dotenv files into the process env via
 * `godotenv.Load` (`pkg/config/config.go:735-738,1169-1207`; godotenv never
 * overrides an already-set var) *before* Viper's `AutomaticEnv` reads
 * `SUPABASE_PROJECT_ID` (`config.go:534-535`) — so an env-file-only value
 * overrides config.toml too, not only an ambient shell export.
 * `legacyResolveProjectEnvironmentValues` implements that full precedence
 * chain (see its doc comment) on top of `loadProjectEnvironment`'s
 * `supabase/`-dir-only result, so it's used here instead of reading
 * `process.env` directly. It still returns a usable map (falling back to
 * `<workdir>/supabase`/`workdir` and `process.env` itself) even when no
 * `supabase/` config file exists at `workdir`, matching Go's `loadNestedEnv`
 * running unconditionally before `config.toml` is ever opened
 * (`pkg/config/config.go:786-793`) — the `?? process.env[...]` fallback below
 * only still matters for keys neither source produced.
 *
 * The config/env-derived (default) branch is sanitized with
 * `legacySanitizeProjectId` before it's used as a filter value,
 * matching Go's `Config.Validate` sanitizing the `Config.ProjectId`
 * singleton once at config-load time (`pkg/config/config.go:938-944`) — every
 * later reader, including the Docker LABEL `start` writes
 * (`internal/utils/docker.go:375`), sees that same sanitized string. The
 * explicit `--project-id` bypass stays RAW to match: Go assigns the flag
 * value straight to `Config.ProjectId` without going through `Validate`
 * (`internal/stop/stop.go:19-20`).
 *
 * Go's check is `len(projectId) > 0` (`internal/stop/stop.go:18`), not merely
 * "was the flag set" — an explicit but empty `--project-id ""` falls through
 * to the config.toml branch exactly like an absent flag, so that's mirrored
 * here with a non-empty check rather than `Option.isSome` alone.
 */
const resolveSearchProjectIdFilter = Effect.fn("legacy.stop.resolveSearchProjectIdFilter")(
  function* (flags: LegacyStopFlags, cliConfig: LegacyCliConfig["Service"]) {
    // `internal/stop/stop.go:17`'s `if !all` reads the resolved value (not
    // presence), so this branch stays value-based — `Option.getOrElse` mirrors
    // Cobra's `BoolVar` default of `false` when `--all` was never passed.
    if (Option.getOrElse(flags.all, () => false)) return "";
    if (Option.isSome(flags.projectId) && flags.projectId.value.length > 0) {
      return flags.projectId.value;
    }

    // `legacyLoadLocalProjectContext` covers the config-load/env/project-id
    // resolution sequence Go's `flags.LoadConfig` performs (config load +
    // project-id resolution, `internal/utils/flags/config_path.go:10-14` ->
    // `pkg/config/config.go:882`) — see its own doc comment for the full
    // Go-parity rationale (including why workdir validation stays out of it
    // and is instead handled by `legacyStop`'s own unconditional call above).
    const context = yield* legacyLoadLocalProjectContext(
      cliConfig.workdir,
      (message) => new LegacyStopConfigLoadError({ message }),
    );

    // VALIDATE config before any Docker call, matching Go's `flags.LoadConfig`
    // (config load + `Validate`, `internal/utils/flags/config_path.go:10-14` ->
    // `pkg/config/config.go:882`), which the default `stop` path runs in full
    // (`internal/stop/stop.go:15-25`) before ever touching Docker — unlike the
    // `--all`/`--project-id` branches above, which bypass config loading
    // entirely and so must NOT run this. `legacyResolveLocalConfigValues` is
    // reused purely for its throwing side effects (its resolved URLs/keys are
    // discarded); it gives `stop` the same partial-but-growing `Config.Validate`
    // parity `status` already has (`status.handler.ts`), rather than a one-off
    // re-implementation.
    yield* Effect.try({
      try: () =>
        legacyResolveLocalConfigValues(
          context.config,
          context.hostname,
          cliConfig.workdir,
          context.projectEnvValues,
          context.loaded?.document,
        ),
      catch: (cause) =>
        new LegacyStopConfigLoadError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    return context.projectId;
  },
);

export const legacyStop = Effect.fn("legacy.stop")(function* (flags: LegacyStopFlags) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;

  yield* Effect.gen(function* () {
    // Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:231-250`)
    // unconditionally `os.Chdir`s the resolved `--workdir`/`SUPABASE_WORKDIR`
    // in `PersistentPreRunE` (`cmd/root.go:93-105`) — before any of `stop`'s
    // own flag validation or `RunE`. A missing or non-directory path fails
    // immediately, so this must win over every later error, including the
    // `--project-id`/`--all` mutual-exclusivity check below.
    yield* legacyValidateWorkdirIsDirectory(cliConfig.workdir, fs).pipe(
      Effect.mapError((error) => new LegacyStopWorkdirError({ message: error.message })),
    );

    // Presence-based, matching Cobra's `Changed` check (see the doc comment on
    // `all`'s flag definition in `stop.command.ts`) — `--project-id x --all=false`
    // must reject too, not just `--all`/`--all=true`.
    if (Option.isSome(flags.projectId) && Option.isSome(flags.all)) {
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

    // Go prints this line unconditionally and immediately — `docker.go:97`'s
    // `fmt.Fprintln(w, "Stopping containers...")`, where `w` is a
    // `StatusWriter` that `fmt.Println`s straight to stdout in non-interactive
    // mode (`tea.go:59-60,87-90`) before any Docker call runs. The debounced
    // `output.task` spinner used elsewhere in this codebase gates its message
    // behind a delay, which drops this line whenever the underlying calls
    // resolve faster than that threshold — exactly what happens against the
    // mocked/replayed Docker CLI. Print it directly so it always appears.
    if (output.format === "text") {
      yield* output.raw("Stopping containers...\n");
    }

    // Go's `DockerRemoveAll` (`apps/cli-go/internal/utils/docker.go:96-146`): list -> stop
    // concurrently -> container prune -> conditional volume prune -> network prune. See
    // `legacy-docker-remove-all.ts` for the full Go-parity rationale. Its 5 neutral, stage-tagged
    // failure variants are remapped here into `stop`'s own tagged errors.
    yield* legacyDockerRemoveAll(spawner, filterValue, deleteVolumes).pipe(
      Effect.catchTags({
        LegacyDockerRemoveAllListError: (error) =>
          Effect.fail(new LegacyStopListError({ message: error.message })),
        LegacyDockerRemoveAllStopError: (error) =>
          Effect.fail(new LegacyStopContainerError({ message: error.message })),
        LegacyDockerRemoveAllContainerPruneError: (error) =>
          Effect.fail(new LegacyStopContainerPruneError({ message: error.message })),
        LegacyDockerRemoveAllVolumePruneError: (error) =>
          Effect.fail(new LegacyStopVolumePruneError({ message: error.message })),
        LegacyDockerRemoveAllNetworkPruneError: (error) =>
          Effect.fail(new LegacyStopNetworkPruneError({ message: error.message })),
      }),
    );

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
