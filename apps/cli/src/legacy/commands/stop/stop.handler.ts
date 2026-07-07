import { loadProjectConfig, loadProjectEnvironment, ProjectConfigSchema } from "@supabase/config";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Effect, FileSystem, Option, Result, Schema } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { legacyAqua } from "../../shared/legacy-colors.ts";
import {
  containerCliExitCode,
  legacyDescribeContainerCliFailure,
  legacyDockerSupportsVolumePruneAllFlag,
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
import { legacyGetHostname } from "../../shared/legacy-hostname.ts";
import { legacyResolveLocalConfigValues } from "../../shared/legacy-local-config-values.ts";
import { legacyResolveProjectEnvironmentValues } from "../../shared/legacy-project-environment.ts";
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
 * {@link legacySanitizeProjectId} before it's used as a filter value,
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

    // `search: false`: `cliConfig.workdir` already IS Go's fully-resolved chdir
    // target (`legacy-cli-config.layer.ts`'s `resolveWorkdir` mirrors
    // `ChangeWorkDir`'s explicit-exact-vs-default-searched resolution,
    // `apps/cli-go/internal/utils/misc.go:231-247`), so letting
    // `@supabase/config`'s `findProjectPaths` climb ancestors again on top of
    // that would let an unrelated ancestor project's config.toml win when
    // `--workdir`/`SUPABASE_WORKDIR` points at a subdirectory with no
    // `supabase/config.toml` of its own — Go never searches past the exact
    // (explicit or defaulted) workdir (`NewPathBuilder`, `pkg/config/utils.go:
    // 43-48`).
    const projectEnv = yield* loadProjectEnvironment({
      cwd: cliConfig.workdir,
      baseEnv: process.env,
      search: false,
      // Go's `loadDefaultEnv` (`apps/cli-go/pkg/config/config.go:1243-1250`)
      // omits `.env.local` from its candidate list whenever
      // `SUPABASE_ENV=test` — a malformed or intentionally non-test
      // `supabase/.env.local` is then invisible to Go and must not fail
      // config loading here either. `legacyResolveProjectEnvironmentValues`
      // below already applies this same gate for the project-root pass (see
      // its `candidateDotenvFilenames`); this mirrors it for the
      // `supabase/`-dir pass `loadProjectEnvironment` itself performs.
      skipEnvLocal: (process.env["SUPABASE_ENV"] || "development") === "test",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyStopConfigLoadError({ message: `failed to read config: ${String(cause)}` }),
      ),
    );

    // Resolved BEFORE `loadProjectConfig` decodes config.toml (not after):
    // Go's `Config.Load` runs `loadNestedEnv` before `LoadEnvHook` decodes
    // `env(...)` references (`config.go:735-738`), so an `env(...)`-valued
    // `project_id` sourced only from a project-root/`SUPABASE_ENV`-selected
    // file must already be visible to the decoder, not just to the
    // `SUPABASE_PROJECT_ID` override read below. A malformed extra dotenv
    // file throws here (see `readDotEnvFile`), matching Go's `loadNestedEnv`
    // propagating `godotenv`'s parse error instead of silently skipping the
    // bad line. `workdir` is passed through so dotenv files under
    // `<workdir>/supabase`/`workdir` are still discovered even when
    // `projectEnv` is `null` (no config.toml there) — Go's own `loadNestedEnv`
    // runs unconditionally, before `config.toml` is ever opened
    // (`pkg/config/config.go:786-793`).
    const projectEnvValues = yield* Effect.try({
      try: () => legacyResolveProjectEnvironmentValues(projectEnv, cliConfig.workdir),
      catch: (cause) =>
        new LegacyStopConfigLoadError({ message: `failed to read config: ${String(cause)}` }),
    });

    // An absent config.toml is not a failure — Go's `flags.LoadConfig` still
    // resolves a project id via the workdir basename default. Only a
    // malformed file (`loadProjectConfig` failing rather than returning
    // `null`) is a hard error, matching `gen types`'s `loadConfig()` pattern.
    const loaded = yield* loadProjectConfig(cliConfig.workdir, {
      projectEnv: projectEnv !== null ? { ...projectEnv, values: projectEnvValues } : undefined,
      search: false,
      // Go's `NewPathBuilder`/`Config.Load` (`pkg/config/utils.go:43-48`) only
      // ever resolves `supabase/config.toml` — it has no concept of a JSON
      // project config file. Without this, a workdir with a stray
      // `config.json` would make `loadProjectConfig` prefer it over
      // `config.toml`, potentially stopping containers for the wrong project.
      tomlOnly: true,
      goViperCompat: true,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyStopConfigLoadError({ message: `failed to read config: ${String(cause)}` }),
      ),
    );
    const config = loaded?.config ?? Schema.decodeUnknownSync(ProjectConfigSchema)({});

    // VALIDATE config before any Docker call, matching Go's `flags.LoadConfig`
    // (config load + `Validate`, `internal/utils/flags/config_path.go:10-14` ->
    // `pkg/config/config.go:882`), which the default `stop` path runs in full
    // (`internal/stop/stop.go:15-25`) before ever touching Docker — unlike the
    // `--all`/`--project-id` branches above, which bypass config loading
    // entirely and so must NOT run this. `legacyResolveLocalConfigValues` is
    // reused purely for its throwing side effects (its resolved URLs/keys are
    // discarded); it gives `stop` the same partial-but-growing `Config.Validate`
    // parity `status` already has (`status.handler.ts`), rather than a one-off
    // re-implementation. `legacyGetHostname` has no Docker dependency, so it's
    // safe to call speculatively here too.
    yield* Effect.try({
      try: () =>
        legacyResolveLocalConfigValues(
          config,
          legacyGetHostname(),
          cliConfig.workdir,
          projectEnvValues,
          loaded?.document,
        ),
      catch: (cause) =>
        new LegacyStopConfigLoadError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    const resolved = legacyResolveLocalProjectId(
      projectEnvValues["SUPABASE_PROJECT_ID"] ?? process.env["SUPABASE_PROJECT_ID"],
      config.project_id,
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

    yield* Effect.gen(function* () {
      const containerIds = yield* legacyListContainersByLabel(spawner, {
        projectIdFilter: filterValue,
        all: true,
        format: "id",
      }).pipe(Effect.mapError((cause) => new LegacyStopListError({ message: cause.message })));

      // Go stops containers concurrently via `WaitAll`, joining every failure
      // rather than short-circuiting on the first one (`docker.go:96-146`).
      //
      // `stdout`/`stderr: "ignore"` on every exit-code-only call below: none of
      // these read the child's own output, and the default `"pipe"` stdio
      // otherwise leaves an OS pipe unread — once `docker`/`podman` write
      // enough to it (e.g. `container prune`'s "Deleted Containers" ID list on
      // a host with many stale containers, most likely under `stop --all`),
      // the child blocks on write() and `stop` hangs. Matches the existing
      // `stdio: "ignore"` precedent for the same "exit-code-only" shape in
      // `legacy-pgdelta.seam.layer.ts`.
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
          new LegacyStopContainerError({
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
        // Go gates the `--all` filter arg on Docker API >= 1.42
        // (`docker.go:126-133`, `Docker.ClientVersion() >= "1.42"`): Docker
        // CLI's own `volume prune --all` flag is annotated `version: "1.42"`
        // (`docker/cli@v28.5.2` `cli/command/volume/prune.go:53`) and enforced
        // by Cobra's `Args` validator *before* `RunE` runs
        // (`cmd/docker/docker.go:659-660`) — on an older daemon, passing
        // `--all` unconditionally would hard-fail this whole call and prune
        // nothing, not just prune a narrower set. There's no persistent
        // Engine API client here to ask the negotiated version directly (Go
        // talks to the Docker Engine API, never a `docker` binary), so
        // {@link legacyDockerSupportsVolumePruneAllFlag} asks the `docker` CLI
        // itself via `docker version` and mirrors Go's gate exactly.
        //
        // Podman is a Docker-CLI-compatible fallback this port adds, not something
        // Go itself has, so there's no Go behavior to match on that path — but
        // `--all` isn't a real flag on any released Podman `volume prune` (only
        // `--filter`/`--force`/`--help`, checked v4.3 through the current v5.7;
        // `--all` only exists in unreleased dev docs), so it hard-fails on a real
        // Podman-only host. Podman already prunes every unused volume by default,
        // so omitting `--all` on the Podman fallback is a lossless fix.
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

      const networkPruneExitCode = yield* containerCliExitCode(
        spawner,
        ["network", "prune", "--force", "--filter", `label=${filterValue}`],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      ).pipe(
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
    });

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
