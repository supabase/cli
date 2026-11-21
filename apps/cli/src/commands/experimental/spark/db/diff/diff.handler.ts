import { Effect, FileSystem, Option, Path } from "effect";

import { Output } from "../../../../../shared/output/output.service.ts";
import {
  filesForDeclarativeShadowLoad,
  prepareDeclarativeShadow,
} from "../../../../../command-internal/db/pgdelta/pgdelta-declarative-shadow-prep.ts";
import {
  LoadPgDeltaSqlFiles,
  ReadPgDeltaExportManifest,
} from "../../../../../command-internal/db/pgdelta/pgdelta-files.ts";
import { PgDeltaNextAdapter } from "../../../../../command-internal/db/pgdelta/pgdelta-next-adapter.service.ts";
import { reportPgDeltaNextDiagnostics } from "../../../../../command-internal/db/pgdelta/pgdelta-next-diagnostics.ts";
import type { TargetFlagValues } from "../../../../../command-internal/target/target-flags.ts";
import { isRefused } from "../../spark-api.ts";
import { SparkBackendError, SparkMigrationRefusedError } from "../../spark-project.ts";
import { locateInSchemaFiles } from "../../spark-schema-files.ts";
import { acquireSparkShadows, loadSparkDump } from "../../spark-shadow.ts";
import { projectPaths, reportRefusals } from "../../spark.shared.ts";
import { migrationVersion, SparkTarget, withSparkTarget } from "../../spark-target.ts";

/**
 * `supabase db diff`: plans `supabase/schemas` against the project's dump in a shadow Postgres
 * with pg-delta, then dry-runs the migration on Spark; a refused statement writes nothing.
 */
export const sparkDbDiff = Effect.fn("spark.db.diff")(function* (
  flags: TargetFlagValues & {
    readonly schema: ReadonlyArray<string>;
    readonly file: Option.Option<string>;
  },
) {
  yield* withSparkTarget(flags, () =>
    Effect.gen(function* () {
      const spark = yield* SparkTarget;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const output = yield* Output;
      const pgDelta = yield* PgDeltaNextAdapter;
      const paths = yield* projectPaths();
      if (!(yield* fs.exists(paths.schemas)))
        return yield* new SparkBackendError({
          message: "no supabase/schemas directory: run `supabase db pull` first",
        });
      const files = yield* LoadPgDeltaSqlFiles(fs, path, paths.schemas);
      const manifest = yield* ReadPgDeltaExportManifest(fs, path, paths.schemas);
      const dump = yield* spark.dump(flags.schema);
      const plan = yield* Effect.scoped(
        Effect.gen(function* () {
          const [target, desired] = yield* acquireSparkShadows(2);
          if (target === undefined || desired === undefined)
            return yield* Effect.die("no shadow database");
          yield* loadSparkDump(target, dump);
          const prep = yield* prepareDeclarativeShadow(desired, files);
          return yield* pgDelta.planDeclarativeSchema({
            targetPool: target,
            shadowPool: desired,
            files: filesForDeclarativeShadowLoad(files, prep.restorePgjwt),
            allowDrops: true,
            debug: false,
            schema: flags.schema,
            ...(manifest === undefined ? {} : { manifest }),
          });
        }),
      ).pipe(Effect.withSpan("spark.db.diff.plan"));
      yield* reportPgDeltaNextDiagnostics("declarativePlan", plan.diagnostics, false, false);
      yield* Effect.annotateCurrentSpan({ "diff.empty": !plan.changes });
      if (!plan.changes || plan.sql.trim() === "")
        return yield* output.raw("No schema changes found\n");

      const name = Option.getOrElse(flags.file, () => "db_diff");
      const statuses = yield* spark.dryRunMigration({ query: plan.sql, name });
      const refused = statuses.filter(isRefused);
      if (refused.length > 0) {
        // A location is a hint; the refusal is reported without one if the analysis fails.
        const declared = yield* locateInSchemaFiles(
          refused.map((status) => status.statement),
          files,
        ).pipe(Effect.orElseSucceed(() => []));
        yield* reportRefusals(
          "the generated migration",
          refused.map((status, i) => {
            const at = declared[i];
            return {
              status,
              at: at === undefined ? undefined : `supabase/schemas/${at.file}:${at.line}`,
            };
          }),
        );
        return yield* new SparkMigrationRefusedError({
          message: `Spark refuses ${refused.length} statement(s) of the generated migration; no migration was written`,
        });
      }
      yield* output.raw(`Dry run on Spark: OK (${statuses.length} statement(s))\n`, "stderr");
      if (Option.isNone(flags.file)) return yield* output.raw(plan.sql);
      const file = `${yield* migrationVersion}_${flags.file.value}.sql`;
      yield* fs.makeDirectory(paths.migrations, { recursive: true });
      yield* fs.writeFileString(path.join(paths.migrations, file), plan.sql);
      yield* output.raw(`Created new migration at supabase/migrations/${file}\n`, "stderr");
    }),
  );
});
