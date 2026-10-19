import { Config, ConfigProvider, Effect, FileSystem, Option, Path } from "effect";

import { aqua } from "../../../command-internal/colors.ts";
import { loadProjectEnvValues } from "../../../command-internal/db-config.toml-read.ts";
import {
  resolveExperimentalWithProjectEnv,
  WorkdirFlag,
} from "../../../command-internal/global-flags.ts";
import { resolveWorkdir } from "../../../config/command-settings.layer.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { runDbPull } from "../../../command-internal/db-pull-run.ts";
import type { DbPullFlags } from "./pull.command.ts";

/**
 * Resolves the removed `--experimental` structured-dump mode and the project `.env` values from
 * the same workdir `CommandSettings` computes, without loading the profile. Skipped under
 * `--declarative`. Kept out of `runDbPull` so `supabase pull` ignores `SUPABASE_EXPERIMENTAL`.
 */
export const resolveRemovedExperimental = Effect.fn("db.pull.resolveRemovedExperimental")(
  function* (flags: DbPullFlags) {
    if (Option.getOrElse(flags.declarative, () => false)) {
      return { experimental: false, projectEnv: undefined };
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeInfo = yield* RuntimeInfo;
    const provider = yield* ConfigProvider.ConfigProvider;
    const workdirEnvValue = yield* Config.option(Config.String("SUPABASE_WORKDIR")).parse(provider);
    const { workdir } = yield* resolveWorkdir(
      yield* WorkdirFlag,
      workdirEnvValue,
      runtimeInfo.cwd,
      path,
    );
    const projectEnv = yield* loadProjectEnvValues(fs, path, workdir);
    return { experimental: yield* resolveExperimentalWithProjectEnv(projectEnv), projectEnv };
  },
);

/**
 * `dbPull`'s established external behavior (stdout/stderr, JSON payload,
 * "Finished" line), reimplemented on top of {@link runDbPull}: run the
 * pull, then emit based on the returned outcome.
 */
export const dbPull = Effect.fn("db.pull")(function* (
  flags: DbPullFlags,
  projectEnv?: Record<string, string>,
) {
  const output = yield* Output;
  const outcome = yield* runDbPull(flags, { projectEnv });

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
