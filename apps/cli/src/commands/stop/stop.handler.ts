import { Effect, FileSystem, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { emitSuccessTrailer } from "../../shared/cli/success-trailer.ts";
import { Output } from "../../shared/output/output.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { aqua } from "../../command-internal/colors.ts";
import { DebugFlag } from "../../command-internal/global-flags.ts";
import { cliProjectFilterValue } from "../../command-internal/docker-ids.ts";
import {
  listVolumesByLabel,
  type ContainerIdName,
} from "../../command-internal/docker-lifecycle.ts";
import { dockerRemoveAll } from "../../command-internal/docker-remove-all.ts";
import { cleanupStartSecrets } from "../../command-internal/start-secrets-cleanup.ts";
import { resolveLocalConfigValues } from "../../command-internal/local-config-values.ts";
import { loadLocalProjectContext } from "../../command-internal/local-project-context.ts";
import { validateWorkdirIsDirectory } from "../../command-internal/workdir-validation.ts";
import type { StopFlags } from "./stop.command.ts";
import {
  StopConfigLoadError,
  StopContainerError,
  StopContainerPruneError,
  StopListError,
  StopMutuallyExclusiveError,
  StopNetworkPruneError,
  StopVolumePruneError,
  StopWorkdirError,
} from "./stop.errors.ts";

/**
 * Resolves the Docker label filter `stop` searches on: `--all` bypasses config with an empty
 * filter; a non-empty `--project-id` (an empty string falls through like an absent flag)
 * overrides the resolved id directly, unsanitized; otherwise it resolves via config (env → toml
 * → workdir basename, see `resolveProjectEnvironmentValues`), sanitized with `sanitizeProjectId`
 * to match the string the Docker label `start` writes.
 */
const resolveSearchProjectIdFilter = Effect.fn("stop.resolveSearchProjectIdFilter")(function* (
  flags: StopFlags,
  cliSettings: CommandSettings["Service"],
) {
  // Reads `--all`'s resolved value, not its presence; `Option.getOrElse` defaults to `false`
  // when it was never passed.
  if (Option.getOrElse(flags.all, () => false)) return "";
  if (Option.isSome(flags.projectId) && flags.projectId.value.length > 0) {
    return flags.projectId.value;
  }

  // `loadLocalProjectContext` covers the config-load/env/project-id resolution sequence; see its
  // own doc comment (workdir validation is handled separately, by `stop`'s own call above).
  const context = yield* loadLocalProjectContext(
    cliSettings.workdir,
    (message) => new StopConfigLoadError({ message }),
  );

  // Runs full config validation before touching Docker, unlike the `--all`/`--project-id`
  // branches above which bypass config loading. `resolveLocalConfigValues` is reused purely for
  // its throwing side effects — its resolved URLs/keys are discarded — giving `stop` the same
  // config-validation coverage `status` already has.
  yield* Effect.try({
    try: () =>
      resolveLocalConfigValues(
        context.config,
        context.hostname,
        cliSettings.workdir,
        context.projectEnvValues,
        context.loaded?.document,
      ),
    catch: (cause) =>
      new StopConfigLoadError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  return context.projectId;
});

export const stop = Effect.fn("stop")(function* (flags: StopFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  // Threaded into `dockerRemoveAll` below — `--debug` gates that
  // function's `Pruned …:` stderr reports.
  const debug = yield* DebugFlag;

  yield* Effect.gen(function* () {
    // A missing/non-directory `--workdir` must fail before any other validation, including the
    // `--project-id`/`--all` mutual-exclusivity check below.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new StopWorkdirError({ message: error.message })),
    );

    // Presence-based (see `all`'s flag doc comment in stop.command.ts): `--project-id x
    // --all=false` must reject too, not just `--all=true`.
    if (Option.isSome(flags.projectId) && Option.isSome(flags.all)) {
      return yield* Effect.fail(
        new StopMutuallyExclusiveError({
          // The group name keeps declaration order,
          // but the "were all set" list is sorted.
          message:
            "if any flags in the group [project-id all] are set none of the others can be; [all project-id] were all set",
        }),
      );
    }

    const searchProjectIdFilter = yield* resolveSearchProjectIdFilter(flags, cliSettings);
    // The hidden `--backup` flag's value is never read; only `--no-backup` deletes volumes, so
    // `--backup=false` alone is a no-op.
    const deleteVolumes = flags.noBackup;
    const filterValue = cliProjectFilterValue(searchProjectIdFilter);

    // Printed directly (not via `output.task`'s debounced spinner) so it always appears — the
    // spinner's delay drops the message when Docker calls resolve faster than the threshold, as
    // they do against mocked/replayed Docker.
    if (output.format === "text") {
      yield* output.raw("Stopping containers...\n");
    }

    // Stages: list -> stop -> container prune -> volume prune (when requested) -> network prune;
    // each stage's failure is remapped to a `stop` error below.
    //
    // `onContainersRemoved` fires only after container prune confirms removal, and each container's
    // own `CLI_WORKDIR_LABEL` locates its secrets directory (`--all`/`--project-id` may tear down
    // another project's containers). The cleanup runs via `Effect.ensuring` so a later prune-stage
    // failure can't skip it and leak secret directories.
    let removedContainers: ReadonlyArray<ContainerIdName> = [];
    yield* dockerRemoveAll(
      spawner,
      filterValue,
      deleteVolumes,
      (containers) => {
        removedContainers = containers;
      },
      debug,
    ).pipe(
      Effect.catchTags({
        DockerRemoveAllListError: (error) =>
          Effect.fail(new StopListError({ message: error.message })),
        DockerRemoveAllStopError: (error) =>
          Effect.fail(new StopContainerError({ message: error.message })),
        DockerRemoveAllContainerPruneError: (error) =>
          Effect.fail(new StopContainerPruneError({ message: error.message })),
        DockerRemoveAllVolumePruneError: (error) =>
          Effect.fail(new StopVolumePruneError({ message: error.message })),
        DockerRemoveAllNetworkPruneError: (error) =>
          Effect.fail(new StopNetworkPruneError({ message: error.message })),
      }),
      Effect.ensuring(
        Effect.suspend(() => cleanupStartSecrets(removedContainers, cliSettings.workdir)),
      ),
    );

    if (output.format === "text") {
      // Written to stdout: `aqua` must target stdout's own TTY status, not stderr's; see
      // `colors.ts`'s doc comment.
      yield* output.raw(`Stopped ${aqua("supabase", process.stdout)} local development setup.\n`);
    } else {
      yield* output.success("Stopped supabase local development setup.", {
        project_id_filter: searchProjectIdFilter,
        backup: !deleteVolumes,
      });
    }

    // Only meaningful in text mode; json/stream-json payloads have no equivalent field for this hint.
    if (output.format === "text") {
      const remainingVolumes = yield* listVolumesByLabel(spawner, filterValue).pipe(
        Effect.orElseSucceed(() => []),
      );
      if (remainingVolumes.length > 0) {
        const listVolumeCommand =
          searchProjectIdFilter.length > 0
            ? `docker volume ls --filter label=com.supabase.cli.project=${searchProjectIdFilter}`
            : "docker volume ls --filter label=com.supabase.cli.project";
        yield* emitSuccessTrailer(
          `Local data are backed up to docker volume. Use docker to show them: ${aqua(listVolumeCommand)}\n`,
        );
      }
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
