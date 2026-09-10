import { Effect, Option } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { startLocalDatabase } from "../../../command-internal/db-bootstrap/start-local-database.ts";
import type { DbStartFlags } from "./start.command.ts";

/**
 * `supabase db start` — start the local Postgres database. Fully native: the bring-up
 * sequence is the shared `startLocalDatabase` helper, also used by `db schema declarative`'s
 * `ensureLocalDatabaseStarted`. This handler only adds the output-format-aware terminal
 * message and telemetry flush. Unlike `supabase start`, it has no status table, no
 * `cli_stack_started` event, and no `--exclude`/`--ignore-health-check` flags.
 */
export const dbStart = Effect.fn("db.start")(function* (flags: DbStartFlags) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;

  const body = Effect.gen(function* () {
    const result = yield* startLocalDatabase(Option.getOrUndefined(flags.fromBackup));

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
