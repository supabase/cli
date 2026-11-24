import { Effect, FileSystem, Path } from "effect";

import { Output } from "../../../../../shared/output/output.service.ts";
import { reportPgDeltaNextDiagnostics } from "../../../../../command-internal/db/pgdelta/pgdelta-next-diagnostics.ts";
import { PgDeltaNextAdapter } from "../../../../../command-internal/db/pgdelta/pgdelta-next-adapter.service.ts";
import { writeDeclarativeSchemas } from "../../../../../command-internal/db/pgdelta/pgdelta.write.ts";
import type { SparkTargetFlagValues } from "../../spark.flags.ts";
import { withoutBaselineFiles } from "../../spark-schema-files.ts";
import { acquireSparkShadows, loadSparkDump } from "../../spark-shadow.ts";
import { projectPaths } from "../../spark.shared.ts";
import { SparkTarget, withSparkTarget } from "../../spark-target.ts";

/** `supabase db pull`: the project's dump, loaded into a shadow Postgres, exported to `supabase/schemas`. */
export const sparkDbPull = Effect.fn("spark.db.pull")(function* (
  flags: SparkTargetFlagValues & { readonly schema: ReadonlyArray<string> },
) {
  yield* withSparkTarget(flags, () =>
    Effect.gen(function* () {
      const spark = yield* SparkTarget;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const output = yield* Output;
      const pgDelta = yield* PgDeltaNextAdapter;
      const paths = yield* projectPaths();
      const dump = yield* spark.dump(flags.schema);
      const exported = yield* Effect.scoped(
        Effect.gen(function* () {
          const [pool, clean] = yield* acquireSparkShadows(2);
          if (pool === undefined || clean === undefined)
            return yield* Effect.die("no shadow database");
          yield* loadSparkDump(pool, dump);
          const full = yield* pgDelta.exportDeclarativeSchema({ pool, schema: flags.schema });
          // The image's own grants, default privileges and extensions are not in Spark.
          const baseline = yield* pgDelta.exportDeclarativeSchema({
            pool: clean,
            schema: flags.schema,
          });
          return withoutBaselineFiles(full, baseline);
        }),
      ).pipe(Effect.withSpan("spark.db.pull.export"));
      yield* reportPgDeltaNextDiagnostics("declarativeExport", exported.diagnostics, false, false);
      yield* writeDeclarativeSchemas(fs, path, paths.schemas, exported);
      yield* output.raw(
        `Exported ${exported.files.length} file(s) to ${paths.schemas}\n`,
        "stderr",
      );
      yield* output.raw("Finished supabase db pull.\n");
    }),
  );
});
