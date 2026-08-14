import { Effect, Option } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyStartLocalDatabase } from "../../../shared/db-bootstrap/start-local-database.ts";
import type { LegacyDbStartFlags } from "./start.command.ts";

/**
 * `supabase db start` — start the local Postgres database.
 *
 * Fully native. The actual bring-up sequence (config load+validate, the already-running
 * short-circuit, network/volume/container bring-up, health wait, fresh-volume setup,
 * `_current_branch`) is the shared `legacyStartLocalDatabase` helper
 * (`shared/db-bootstrap/start-local-database.ts`) — also used by the `db schema declarative`
 * seam's `ensureLocalDatabaseStarted`, so there is one implementation. This handler only adds
 * `db start`'s own output-format-aware terminal message and telemetry flush.
 *
 * Parity notes: this is `db start`, NOT the top-level `supabase start`. It does NOT print a
 * status table and does NOT fire `cli_stack_started` — those belonged to the deleted
 * `internal/start/start.go` and are now natively ported in `legacy/commands/start/`. There is
 * no `Finished` line. Unlike `supabase start`, there is no `--exclude`/`--ignore-health-check`
 * here at all (`db start` has neither flag) — a health-check timeout always fails the command
 * UNLESS `--from-backup` is set, in which case `legacyStartLocalDatabase` itself swallows it (a
 * large restore can take longer than the health timeout) and the command still succeeds.
 * `--exclude`'s absence also means the fresh-volume one-shot setup jobs (realtime/storage/auth
 * migrate) are gated purely on each service's own `enabled` flag, with no `--exclude` filtering
 * to layer on top.
 */
export const legacyDbStart = Effect.fn("legacy.db.start")(function* (flags: LegacyDbStartFlags) {
  const output = yield* Output;
  const telemetryState = yield* LegacyTelemetryState;

  const body = Effect.gen(function* () {
    const result = yield* legacyStartLocalDatabase(Option.getOrUndefined(flags.fromBackup));

    if (result.status === "already-running") {
      if (output.format === "text") {
        yield* output.raw("Postgres database is already running.\n", "stderr");
      } else {
        yield* output.success("Postgres database is already running.", {
          status: "already-running",
        });
      }
      return;
    }

    if (output.format !== "text") {
      yield* output.success("Started local database.", { status: "started" });
    }
  });

  // db start is local-only — no project ref, so no linked-project cache write.
  // Telemetry still flushes on success and failure.
  yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
