import { Effect, Schema } from "effect";

import type { Description } from "./meta/Description.ts";
import { typescript } from "./meta/Typegen.ts";
import type { SparkAdmin } from "./meta/Admin.ts";

export { makeSparkAdmin, type SparkAdmin, type SparkAdminError } from "./meta/Admin.ts";
export type { SparkTypegenError } from "./meta/Typegen.ts";

/** Where a Spark schema description comes from: the admin client, or a cache in front of it. */
interface DescriptionSource<E> {
  readonly schema: Effect.Effect<Description, E>;
}

/** TypeScript types for `schemas`, `public` when none are given. */
export const sparkTypescriptTypes = <E>(
  source: DescriptionSource<E>,
  schemas: ReadonlyArray<string> | undefined,
) =>
  source.schema.pipe(
    Effect.flatMap((description) => typescript(description, schemas ?? ["public"])),
    Effect.withSpan("Spark.typescriptTypes"),
  );

/** One statement's status in a dry run, as the Management API's `?dry_run=true` answers it. */
export const SparkDryRunStatus = Schema.Struct({
  index: Schema.Finite,
  kind: Schema.String,
  status: Schema.String,
  code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(Schema.NullOr(Schema.String)),
  line: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  statement: Schema.String,
});
export interface SparkDryRunStatus extends Schema.Schema.Type<typeof SparkDryRunStatus> {}

export const oneLine = (s: string, n = 160): string => s.replace(/\s+/gu, " ").trim().slice(0, n);

/**
 * Dry-runs a migration on Spark, applying nothing. A status without Spark's own statement text
 * takes it from `statementAt`.
 */
export const sparkDryRun = Effect.fn("Spark.dryRun")(function* (
  admin: SparkAdmin,
  migration: { readonly version: string; readonly name: string; readonly sql: string },
  statementAt: (index: number) => string | undefined = () => undefined,
) {
  const { statuses } = yield* admin.dryRunMigration(
    migration.version,
    migration.name,
    migration.sql,
  );
  yield* Effect.annotateCurrentSpan({ "spark.dry_run.statements": statuses.length });
  return statuses.map((s): SparkDryRunStatus => ({
    ...s,
    statement: oneLine(s.statement ?? statementAt(s.index) ?? "", 200),
  }));
});
