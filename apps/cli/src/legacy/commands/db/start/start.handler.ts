import { Effect, FileSystem, Option, Path } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyCheckDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbBootstrapSeam } from "../shared/legacy-db-bootstrap.seam.service.ts";
import type { LegacyDbStartFlags } from "./start.command.ts";

/**
 * `supabase db start` — start the local Postgres database.
 *
 * Strict 1:1 port of `apps/cli-go/internal/db/start/start.go` `Run`. Native TS
 * orchestrates: it validates config, checks whether the database is already
 * running (printing Go's "already running" line), and otherwise delegates the
 * container bootstrap to the hidden Go `__db-bootstrap` seam (create container +
 * health + initial schema + `_current_branch`), whose progress is teed to stderr.
 *
 * Parity notes: this is `db start`, NOT the top-level `supabase start`. It does
 * NOT print a status table and does NOT fire `cli_stack_started` — those belong to
 * `internal/start/start.go`. There is no `Finished` line.
 */
export const legacyDbStart = Effect.fn("legacy.db.start")(function* (flags: LegacyDbStartFlags) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const seam = yield* LegacyDbBootstrapSeam;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;

  const body = Effect.gen(function* () {
    // Go's `flags.LoadConfig(fsys)` runs first thing in `start.Run`
    // (`internal/db/start/start.go:45`): a missing config is tolerated (defaults), but
    // a present config that is malformed, references an undecryptable `encrypted:`
    // secret, or fails Validate aborts before any container work. `legacyCheckDbToml`
    // is that exact load+validate — call it here (not via the seam's best-effort read,
    // which swallows config errors) so `db start` fails fast on a broken config.
    yield* legacyCheckDbToml(fs, path, cliConfig.workdir);

    // Go's AssertSupabaseDbIsRunning: if the db container is already up, print to
    // stderr and return nil (exit 0).
    const running = yield* seam.isDbRunning();
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

    // Not running → bootstrap the container (StartDatabase + DockerRemoveAll on
    // failure). The seam tees "Starting database...", "Initialising schema...",
    // etc. to stderr.
    //
    // Resolve a relative `--from-backup` against the CALLER's cwd, mirroring Go's
    // `StartDatabase` (`filepath.Join(utils.CurrentDirAbs, fromBackup)`, start.go:160-161)
    // where `CurrentDirAbs` is captured before `ChangeWorkDir`. The seam spawns the Go child
    // with cwd = the project workdir, so passing a relative path would resolve it against the
    // project root (wrong file / not found) when `db start` runs from a subdirectory or with
    // `--workdir`. Passing an absolute path makes the child's resolution a no-op.
    const fromBackupFlag = Option.getOrUndefined(flags.fromBackup);
    // An empty `--from-backup ""` is a normal no-backup start in Go (`len(fromBackup) == 0`),
    // so treat it as absent rather than joining it to a directory path.
    const fromBackup =
      fromBackupFlag === undefined || fromBackupFlag === ""
        ? undefined
        : path.isAbsolute(fromBackupFlag)
          ? fromBackupFlag
          : path.join(runtimeInfo.cwd, fromBackupFlag);
    yield* seam.startDatabase({ fromBackup });

    if (output.format !== "text") {
      yield* output.success("Started local database.", { status: "started" });
    }
  });

  // db start is local-only — no project ref, so no linked-project cache write.
  // Telemetry still flushes on success and failure (Go's PersistentPostRun).
  yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
