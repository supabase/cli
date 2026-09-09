import { Effect } from "effect";

import { aqua } from "../../../command-internal/colors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { runDbPull, type DbPullInvoke } from "../../../command-internal/db-pull-run.ts";
import type { DbPullFlags } from "./pull.command.ts";

/**
 * `dbPull`'s established external behavior (stdout/stderr, JSON payload,
 * "Finished" line), reimplemented on top of {@link runDbPull}: run the
 * pull, then emit based on the returned outcome.
 */
export const dbPull = Effect.fn("db.pull")(function* (flags: DbPullFlags, invoke?: DbPullInvoke) {
  const output = yield* Output;
  const outcome = yield* runDbPull(flags, invoke);

  if (output.format !== "text") {
    if (outcome.kind === "declarative") {
      yield* output.success("Declarative schema pulled.", {
        declarative: true,
        schemaWritten: outcome.schemaWritten,
        remoteHistoryUpdated: false,
        engine: outcome.engine,
      });
    } else {
      const schemaWritten = outcome.schemaFiles[0];
      if (schemaWritten === undefined) {
        // Unreachable: a "migration" outcome only reaches this emission after
        // `runDbPull` confirmed at least one migration file was written
        // (the migra path always pushes exactly one; the pg-delta path's
        // `planFiles` is non-empty whenever the diff wasn't already caught by
        // the `diffEmpty` in-sync failure above).
        return yield* Effect.die(
          new Error("db pull: schemaFiles was empty for a migration outcome"),
        );
      }
      yield* output.success("Schema pulled.", {
        declarative: false,
        // `schemaWritten` keeps the first written path for released consumers that
        // read the string field; `schemaFiles` lists EVERY written migration path
        // in write order (a pg-delta plan writes one file per unit), so machine
        // callers see all of them, not just the first.
        schemaWritten,
        schemaFiles: outcome.schemaFiles,
        remoteHistoryUpdated: outcome.remoteHistoryUpdated,
        engine: outcome.engine,
      });
    }
  } else if (invoke?.skipFinishedLine !== true) {
    yield* output.raw(`Finished ${aqua("supabase db pull")}.\n`);
  }
});
