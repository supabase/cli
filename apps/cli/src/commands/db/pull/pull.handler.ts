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
        // Unreachable: `runDbPull` only returns a "migration" outcome after confirming at
        // least one migration file was written (migra always pushes one; pg-delta's
        // `planFiles` is non-empty unless already caught by the in-sync failure above).
        return yield* Effect.die(
          new Error("db pull: schemaFiles was empty for a migration outcome"),
        );
      }
      yield* output.success("Schema pulled.", {
        declarative: false,
        // `schemaWritten` is the first path, kept for consumers reading the string field;
        // `schemaFiles` lists every written path in order (pg-delta writes one per unit).
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
