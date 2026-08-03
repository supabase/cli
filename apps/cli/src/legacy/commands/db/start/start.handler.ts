import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyDebugFlag, LegacyNetworkIdFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyCheckDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyCliProjectFilterValue } from "../../../shared/legacy-docker-ids.ts";
import { legacyBuildLocalDbContainerInputs } from "../../../shared/db-bootstrap/local-container-inputs.ts";
import { legacyIsLocalDbRunning } from "../../../shared/db-bootstrap/local-db-running.ts";
import { legacyRollbackStart } from "../../../shared/db-bootstrap/rollback.ts";
import { legacyStartDatabase } from "../../../shared/db-bootstrap/start-database.ts";
import type { LegacyDbStartFlags } from "./start.command.ts";

/**
 * `supabase db start` — start the local Postgres database.
 *
 * Strict 1:1 port of `apps/cli-go/internal/db/start/start.go` `Run` + `StartDatabase`.
 * `Run` is native TS here: config load+validate, the already-running short-circuit, and
 * this command's own lean prelude. The `StartDatabase` sequence itself
 * (network/volume/container bring-up, health wait, fresh-volume setup, `_current_branch`)
 * is the SAME shared function `supabase start` uses — see
 * `legacy/shared/db-bootstrap/start-database.ts`'s header for why this is a single,
 * shared TS home rather than two independently-drifting copies. The already-running
 * check (`legacyIsLocalDbRunning`) is already a native TS implementation of
 * `AssertSupabaseDbIsRunning` (a plain `docker container inspect`), not a Go subprocess
 * or a seam call — `db start` composes no `LegacyDbBootstrapSeam` at all anymore; the
 * container-bootstrap Go delegation (`db __db-bootstrap --mode start`) has been
 * removed entirely.
 *
 * Parity notes: this is `db start`, NOT the top-level `supabase start`. It does NOT print
 * a status table and does NOT fire `cli_stack_started` — those belong to
 * `internal/start/start.go`. There is no `Finished` line. Unlike `supabase start`, there
 * is no `--exclude`/`--ignore-health-check` here at all (Go's `db start` has neither
 * flag) — a health-check timeout always fails the command UNLESS `--from-backup` is set,
 * in which case `legacyStartDatabase` itself swallows it (a large restore can take longer
 * than the health timeout, `start.go:179-181`) and the command still succeeds.
 * `--exclude`'s absence also means the fresh-volume one-shot setup jobs (realtime/storage/
 * auth migrate) are gated purely on each service's own `enabled` flag, with no `--exclude`
 * filtering to layer on top.
 */
export const legacyDbStart = Effect.fn("legacy.db.start")(function* (flags: LegacyDbStartFlags) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const networkIdFlag = yield* LegacyNetworkIdFlag;
  // Gates `legacyDockerRemoveAll`'s (via `legacyRollbackStart`) `--debug` "Pruned …:"
  // stderr reports on a rollback, matching `supabase start`'s own threading.
  const debug = yield* LegacyDebugFlag;

  const body = Effect.gen(function* () {
    // Go's `flags.LoadConfig(fsys)` runs first thing in `start.Run`
    // (`internal/db/start/start.go:45`): a missing config is tolerated (defaults), but
    // a present config that is malformed, references an undecryptable `encrypted:`
    // secret, or fails Validate aborts before any container work. `legacyCheckDbToml`
    // is that exact load+validate — call it here (not via `legacyIsLocalDbRunning`'s
    // best-effort read, which swallows config errors) so `db start` fails fast on a
    // broken config.
    yield* legacyCheckDbToml(fs, path, cliConfig.workdir);

    // Go's AssertSupabaseDbIsRunning: if the db container is already up, print to
    // stderr and return nil (exit 0). Already native — see this module's header.
    const running = yield* legacyIsLocalDbRunning(
      spawner,
      fs,
      path,
      cliConfig.workdir,
      Option.getOrUndefined(cliConfig.projectId),
    );
    if (running) {
      if (output.format === "text") {
        yield* output.raw("Postgres database is already running.\n", "stderr");
      } else {
        yield* output.success("Postgres database is already running.", {
          status: "already-running",
        });
      }
      return;
    }

    // Resolve a relative `--from-backup` against the CALLER's cwd, mirroring Go's
    // `StartDatabase` (`filepath.Join(utils.CurrentDirAbs, fromBackup)`, start.go:160-161)
    // where `CurrentDirAbs` is captured before `ChangeWorkDir`.
    const fromBackupFlag = Option.getOrUndefined(flags.fromBackup);
    // An empty `--from-backup ""` is a normal no-backup start in Go (`len(fromBackup) == 0`),
    // so treat it as absent rather than joining it to a directory path.
    const fromBackup =
      fromBackupFlag === undefined || fromBackupFlag === ""
        ? undefined
        : path.isAbsolute(fromBackupFlag)
          ? fromBackupFlag
          : path.join(runtimeInfo.cwd, fromBackupFlag);

    // Not running → bring up the container natively. `db start`'s OWN lean prelude:
    // config values (via `legacyResolveLocalConfigValues`, matching `stop`/`status`'s own
    // resolver) plus the shared `legacyResolveDbBootstrapConfig` derivation `supabase
    // start` also uses — deliberately narrower than `supabase start`'s own prelude: no
    // `--exclude`, no image pre-pull for any other service, no JWT/JWKS/image resolution
    // beyond what Postgres and its own fresh-volume setup jobs need. Shared with `db reset`'s
    // own identical prelude — see `legacyBuildLocalDbContainerInputs`'s own header for why
    // `fromBackup`/rollback tracking stay here instead of moving into it.
    const inputs = yield* legacyBuildLocalDbContainerInputs(
      spawner,
      cliConfig.workdir,
      networkIdFlag,
      runtimeInfo.platform,
    );
    const {
      context: { projectId, hostname },
      values,
      bootstrapConfig,
      networkId,
      containerOpts,
      dbContainerId,
      postgresSpecBase,
      resolvePostgresImage,
      setup,
    } = inputs;

    const filterValue = legacyCliProjectFilterValue(projectId);

    // Go's `utils.NoBackupVolume` package var — assigned by `legacyStartDatabase`'s own
    // pre-create volume-existence check; defaults to `false` (matching Go's zero value) so a
    // rollback triggered by an earlier failure (e.g. network creation) never deletes a volume
    // this run never confirmed was fresh.
    let isFreshVolume = false;

    // Runs the exact Go `StartDatabase` sequence (network -> volume probe -> container
    // create+start -> health wait -> fresh-volume setup -> `_current_branch`) — shared with
    // `supabase start`, see `legacyStartDatabase`'s own header. Any failure rolls back via the
    // SAME `Effect.onError` wrapper `supabase start` uses (not `tapError` — see
    // `legacyRollbackStart`'s own doc comment for why `onError` is required), matching Go's
    // `Run`, which calls `DockerRemoveAll` on ANY `StartDatabase` failure (`start.go:54-59`).
    yield* legacyStartDatabase(spawner, {
      fs,
      path,
      workdir: cliConfig.workdir,
      projectId,
      networkId,
      hostname,
      dbContainerId,
      dbPort: values.dbPort,
      containerOpts,
      // `fromBackup` (if set) drives BOTH the restore-entrypoint variant and
      // `legacyStartDatabase`'s own backup-volume-exists guard — `db reset` has no
      // `fromBackup` concept at all, so `postgresSpecBase` omits it.
      postgresSpec: { ...postgresSpecBase, fromBackup },
      // Go's `db start` never pre-pulls any OTHER service's image (it has no
      // `ensureImagesCached`-equivalent pre-pull pass at all — `internal/start/start.go`'s own
      // pre-pull is top-level-`start`-only) — only the `db` container's own image, resolved
      // lazily, right where Go's `DockerStart` would resolve it internally
      // (`DockerResolveImageIfNotCached`, `internal/utils/docker.go:363-365`).
      resolvePostgresImage,
      dbHealthTimeoutSeconds: bootstrapConfig.dbHealthTimeoutSeconds,
      // Go's `initSchema15`'s realtime job resolves JWKS itself, LOCALLY, gated on
      // `Realtime.Enabled` (`internal/db/start/start.go:337-341`) — unlike `supabase
      // start`'s OWN unconditional, up-front `ResolveJWKS` call (which also feeds the
      // long-running Realtime/GoTrue/PostgREST containers `db start` never creates).
      // `legacyStartDatabase` only evaluates this Effect when reached AND
      // `realtimeEnabledForSetup` — see its own header for why this is lazy.
      setup,
      onFreshVolumeResolved: (resolved) => {
        isFreshVolume = resolved;
      },
    }).pipe(
      Effect.onError(() =>
        legacyRollbackStart(spawner, filterValue, isFreshVolume, cliConfig.workdir, debug),
      ),
    );

    if (output.format !== "text") {
      yield* output.success("Started local database.", { status: "started" });
    }
  });

  // db start is local-only — no project ref, so no linked-project cache write.
  // Telemetry still flushes on success and failure (Go's PersistentPostRun).
  yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
