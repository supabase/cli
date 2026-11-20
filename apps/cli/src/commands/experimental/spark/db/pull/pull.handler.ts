import { Effect, FileSystem, Option, Path } from "effect";

import { Output } from "../../../../../shared/output/output.service.ts";
import { reportPgDeltaNextDiagnostics } from "../../../../../command-internal/pgdelta/pgdelta-next-diagnostics.ts";
import { PgDeltaNextAdapter } from "../../../../../command-internal/pgdelta/pgdelta-next-adapter.service.ts";
import { writeDeclarativeSchemas } from "../../../../../command-internal/pgdelta/pgdelta.write.ts";
import { dumpSparkSchema } from "../../spark-api.ts";
import { withoutBaselineFiles } from "../../spark-schema-files.ts";
import { acquireSparkShadows, loadSparkDump } from "../../spark-shadow.ts";
import { projectPaths, withLinkedProject } from "../../spark.shared.ts";

/** `supabase db pull`: the project's dump, loaded into a shadow Postgres, exported to `supabase/schemas`. */
export const sparkDbPull = Effect.fn("spark.db.pull")(function* (flags: {
  readonly projectRef: Option.Option<string>;
  readonly schema: ReadonlyArray<string>;
}) {
  yield* withLinkedProject(flags.projectRef, (ref) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const output = yield* Output;
      const pgDelta = yield* PgDeltaNextAdapter;
      const paths = yield* projectPaths();
      const dump = yield* dumpSparkSchema(ref, flags.schema);
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
