import { Effect, Option } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { loadProjectConfig } from "@supabase/config";
import { LegacyDbBootstrapSeam } from "../shared/legacy-db-bootstrap.seam.service.ts";
import type { LegacyDbStartFlags } from "./start.command.ts";
import { LegacyDbStartConfigLoadError } from "./start.errors.ts";

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

  const body = Effect.gen(function* () {
    // Go's `flags.LoadConfig(fsys)` runs first; a malformed config aborts before
    // any container work. A missing config is tolerated here (loadProjectConfig
    // returns null) — the seam's Go LoadConfig then surfaces Go's authoritative
    // missing-config error on the not-running path.
    yield* loadProjectConfig(cliConfig.workdir).pipe(
      Effect.catchTag(
        "ProjectConfigParseError",
        (cause) =>
          new LegacyDbStartConfigLoadError({
            message: `failed to parse supabase/config.toml: ${String(cause.cause)}`,
          }),
      ),
    );

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
    yield* seam.startDatabase({ fromBackup: Option.getOrUndefined(flags.fromBackup) });

    if (output.format !== "text") {
      yield* output.success("Started local database.", { status: "started" });
    }
  });

  // db start is local-only — no project ref, so no linked-project cache write.
  // Telemetry still flushes on success and failure (Go's PersistentPostRun).
  yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
