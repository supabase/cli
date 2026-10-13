import { Effect, FileSystem, Option, Path } from "effect";

import { aqua } from "../../../command-internal/colors.ts";
import { loadProjectEnvValues } from "../../../command-internal/db-config.toml-read.ts";
import { resolveExperimentalWithProjectEnv } from "../../../command-internal/global-flags.ts";
import { removedFlag } from "../../../command-internal/removed-command.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { runDbPull } from "../../../command-internal/db-pull-run.ts";
import type { DbPullFlags } from "./pull.command.ts";

const EXPERIMENTAL_SUGGESTION =
  "Use --declarative to pull per-object schema files, or pass --experimental=false (or unset SUPABASE_EXPERIMENTAL) for a migration pull.";

/**
 * `dbPull`'s established external behavior (stdout/stderr, JSON payload,
 * "Finished" line), reimplemented on top of {@link runDbPull}: run the
 * pull, then emit based on the returned outcome.
 */
export const dbPull = Effect.fn("db.pull")(function* (flags: DbPullFlags) {
  // Checked here rather than in `runDbPull` so the `pull` orchestrator, which calls `runDbPull`
  // directly, keeps working when `SUPABASE_EXPERIMENTAL` is set.
  if (!Option.getOrElse(flags.declarative, () => false)) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliSettings = yield* CommandSettings;
    const projectEnv = yield* loadProjectEnvValues(fs, path, cliSettings.workdir);
    if (yield* resolveExperimentalWithProjectEnv(projectEnv)) {
      return yield* removedFlag(
        "The --experimental structured-dump mode of db pull",
        EXPERIMENTAL_SUGGESTION,
      );
    }
  }
  const output = yield* Output;
  const outcome = yield* runDbPull(flags);

  yield* Effect.annotateCurrentSpan({
    "db.pull.outcome": outcome.kind,
    "db.pull.engine": outcome.engine,
  });

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
  } else {
    yield* output.raw(`Finished ${aqua("supabase db pull")}.\n`);
  }
});
