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
 * Resolve the Docker label filter `stop` searches on. Flag precedence:
 * `--all` bypasses config entirely with an empty filter;
 * `--project-id` overrides the resolved project id directly, also bypassing
 * config.toml; otherwise config loads and the resolved project id
 * (env → toml → workdir basename) is used.
 *
 * "env" is the post-nested-env-load value, not just the ambient shell
 * environment: config loading loads `supabase/.env`/`.env.local` *and*
 * project-root/`SUPABASE_ENV`-selected dotenv files into the process env
 * (never overriding an already-set var) *before* reading
 * `SUPABASE_PROJECT_ID` — so an env-file-only value
 * overrides config.toml too, not only an ambient shell export.
 * `resolveProjectEnvironmentValues` implements that full precedence
 * chain (see its doc comment) on top of `loadCliProjectEnvironment`'s
 * `supabase/`-dir-only result, so it's used here instead of reading
 * `process.env` directly. It still returns a usable map (falling back to
 * `<workdir>/supabase`/`workdir` and `process.env` itself) even when no
 * `supabase/` config file exists at `workdir`, matching the nested-env-load
 * running unconditionally before `config.toml` is ever opened —
 * the `?? process.env[...]` fallback below
 * only still matters for keys neither source produced.
 *
 * The config/env-derived (default) branch is sanitized with
 * `sanitizeProjectId` before it's used as a filter value,
 * matching how config validation sanitizes the resolved project id
 * singleton once at config-load time — every
 * later reader, including the Docker LABEL `start` writes, sees that same
 * sanitized string. The
 * explicit `--project-id` bypass stays RAW to match: the flag
 * value assigns straight to the resolved project id without going through
 * validation.
 *
 * The check is `len(projectId) > 0`, not merely
 * "was the flag set" — an explicit but empty `--project-id ""` falls through
 * to the config.toml branch exactly like an absent flag, so that's mirrored
 * here with a non-empty check rather than `Option.isSome` alone.
 */
const resolveSearchProjectIdFilter = Effect.fn("stop.resolveSearchProjectIdFilter")(function* (
  flags: StopFlags,
  cliSettings: CommandSettings["Service"],
) {
  // The `!all` check reads the resolved value (not
  // presence), so this branch stays value-based — `Option.getOrElse` mirrors
  // the boolean flag's default of `false` when `--all` was never passed.
  if (Option.getOrElse(flags.all, () => false)) return "";
  if (Option.isSome(flags.projectId) && flags.projectId.value.length > 0) {
    return flags.projectId.value;
  }

  // `loadLocalProjectContext` covers the config-load/env/project-id
  // resolution sequence — see its own doc comment for the full
  // rationale (including why workdir validation stays out of it
  // and is instead handled by `stop`'s own unconditional call above).
  const context = yield* loadLocalProjectContext(
    cliSettings.workdir,
    (message) => new StopConfigLoadError({ message }),
  );

  // VALIDATE config before any Docker call — the default `stop` path runs
  // full config validation before ever touching Docker — unlike the
  // `--all`/`--project-id` branches above, which bypass config loading
  // entirely and so must NOT run this. `resolveLocalConfigValues` is
  // reused purely for its throwing side effects (its resolved URLs/keys are
  // discarded); it gives `stop` the same partial-but-growing config validation
  // coverage `status` already has (`status.handler.ts`), rather than a one-off
  // re-implementation.
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
    // The resolved `--workdir`/`SUPABASE_WORKDIR` is `chdir`'d into
    // unconditionally before any of `stop`'s
    // own flag validation or handler body. A missing or non-directory path fails
    // immediately, so this must win over every later error, including the
    // `--project-id`/`--all` mutual-exclusivity check below.
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new StopWorkdirError({ message: error.message })),
    );

    // Presence-based, matching the "explicitly set" check (see the doc comment on
    // `all`'s flag definition in `stop.command.ts`) — `--project-id x --all=false`
    // must reject too, not just `--all`/`--all=true`.
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
    // The hidden `--backup` flag's return value is discarded — never bound to a
    // variable, so the handler always uses `!noBackup` regardless of
    // `--backup`'s value. `--backup=false` is a no-op;
    // only `--no-backup` deletes volumes. Matching that exactly (not the
    // seemingly-intended-but-dead semantics of the flag's own description).
    const deleteVolumes = flags.noBackup;
    const filterValue = cliProjectFilterValue(searchProjectIdFilter);

    // This line prints unconditionally and immediately, straight to stdout,
    // before any Docker call runs. The debounced
    // `output.task` spinner used elsewhere in this codebase gates its message
    // behind a delay, which drops this line whenever the underlying calls
    // resolve faster than that threshold — exactly what happens against the
    // mocked/replayed Docker CLI. Print it directly so it always appears.
    if (output.format === "text") {
      yield* output.raw("Stopping containers...\n");
    }

    // `dockerRemoveAll`: list -> stop
    // concurrently -> container prune -> conditional volume prune -> network prune. See
    // `docker-remove-all.ts` for the full rationale. Its 5 neutral, stage-tagged
    // failure variants are remapped here into `stop`'s own tagged errors.
    //
    // The containers its listing step finds are captured via `onContainersRemoved` — fired only
    // once `container prune` has CONFIRMED they're actually gone (not merely listed), so
    // `cleanupStartSecrets` reclaims exactly the staged-secret directories
    // (`<workdir>/supabase/.temp/start-secrets/<name>`) belonging to containers this run actually
    // tore down, never a guess, never a container the stop stage itself failed on (so `container
    // prune` never ran and nothing was actually removed), and never a blanket delete of the whole
    // parent directory (see that function's doc comment for why that'd be unsafe) — and without a
    // second, separately `docker ps`'d listing call, which would cost an extra real Docker Engine
    // API request (see `dockerRemoveAll`'s doc comment). Each container's own
    // `CLI_WORKDIR_LABEL` value is used to locate its directory — NOT `cliSettings.workdir`
    // unconditionally — since `stop --all`/`stop --project-id <other>` may be tearing down a
    // DIFFERENT project's containers than the one this invocation's own cwd/`--workdir` points at;
    // `cliSettings.workdir` is passed through only as the fallback for a container with no such label
    // (created before this label existed).
    //
    // Run via `Effect.ensuring` rather than a plain statement after this pipe: `dockerRemoveAll`'s
    // LATER stages (volume prune, network prune) can still independently fail AFTER `container
    // prune` has already confirmed removal, and a plain `yield*` below would never run once that
    // later failure propagates — leaking staged secret directories for containers a later `stop`
    // can no longer rediscover (they're already gone). `rollbackStart` (`command-internal/db-bootstrap/rollback.ts`)
    // already runs this same cleanup unconditionally after its own `dockerRemoveAll` call for
    // the identical reason; this makes `stop` consistent with that sibling caller, just without
    // swallowing the teardown error itself. The finalizer is wrapped in `Effect.suspend` so
    // `removedContainers` is read at FINALIZER-RUN time, not at pipe-construction time (before
    // `onContainersRemoved` has fired) — same pattern as
    // `storage/ls/ls.handler.ts`/`storage/rm/rm.handler.ts`.
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
      // Written to stdout (no stream arg): `aqua` must target stdout's own
      // TTY status, not stderr's — see `colors.ts`'s doc comment.
      yield* output.raw(`Stopped ${aqua("supabase", process.stdout)} local development setup.\n`);
    } else {
      yield* output.success("Stopped supabase local development setup.", {
        project_id_filter: searchProjectIdFilter,
        backup: !deleteVolumes,
      });
    }

    // Post-run suggestion: only meaningful in text mode — json/
    // stream-json payloads have no equivalent field to carry this hint.
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
