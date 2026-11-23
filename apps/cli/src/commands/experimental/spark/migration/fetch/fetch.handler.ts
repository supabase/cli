import { Effect, Schema } from "effect";

import {
  resolveOverwriteYes,
  writeMigrationHistory,
} from "../../../../../command-internal/migration-fetch-run.ts";
import type { TargetFlagValues } from "../../../../../command-internal/target/target-flags.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { SparkApiError } from "../../spark-project.ts";
import { SparkTarget, withSparkTarget } from "../../spark-target.ts";

// TEMPORARY: Spark's query route drops the backslash of an escaped character in an array element
// (a newline reads as `n`), so the statements are joined in SQL. Select `statements` once it
// renders an array as Postgres does.
const SELECT_HISTORY =
  "select version, coalesce(name, '') as name, coalesce(array_to_string(statements, ';' || chr(10)), '') as sql from supabase_migrations.schema_migrations order by version";

const History = Schema.Array(
  Schema.Struct({ version: Schema.String, name: Schema.String, sql: Schema.String }),
);

const readHistory = Effect.fn("spark.migration.fetch.read")(function* () {
  const spark = yield* SparkTarget;
  const rows = yield* spark.runQuery(SELECT_HISTORY, true).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(History))),
    Effect.catchTag(
      "SchemaError",
      (cause) =>
        new SparkApiError({
          message: `unexpected migration history response: ${cause.message}`,
          cause,
        }),
    ),
  );
  return rows.map(({ version, name, sql }) => ({ version, name, statements: [sql] }));
});

/** `supabase migration fetch`: writes the project's migration history as local migration files. */
export const sparkMigrationFetch = Effect.fn("spark.migration.fetch")(function* (
  flags: TargetFlagValues,
) {
  yield* withSparkTarget(flags, () =>
    Effect.gen(function* () {
      const output = yield* Output;
      const outcome = yield* writeMigrationHistory({
        read: readHistory(),
        yes: yield* resolveOverwriteYes(),
      });
      yield* Effect.annotateCurrentSpan({ "file.count": outcome.files.length });
      if (output.format !== "text")
        yield* output.success("Migration history fetched", { files: outcome.files });
    }),
  );
});
