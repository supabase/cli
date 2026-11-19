import {
  findLanguage,
  GENERATOR_METADATA_VERSION,
  type GeneratorMetadata,
  type Host,
} from "@supabase/typegen";
import { Data, Effect } from "effect";

import type { Model } from "./Catalog.ts";

export class SparkTypegenError extends Data.TaggedError("SparkTypegenError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The metadata `introspect()` would read from `pg_catalog`, built from Spark's description instead,
 * so the shared generators run unchanged. The description has no functions and no view columns.
 */
const generatorMetadata = (model: Model, schemas: ReadonlyArray<string>): GeneratorMetadata => {
  const { description } = model;
  const included = (schema: string) => schemas.includes(schema);
  const tables = description.tables.filter((t) => included(t.schema));
  return {
    version: GENERATOR_METADATA_VERSION,
    schemas: model.schemas().filter((s) => included(s.name)),
    tables: tables.map((t) => ({
      id: model.tableId(t),
      schema: t.schema,
      name: t.name,
      rls_enabled: t.rls_enabled,
      rls_forced: t.rls_forced,
      replica_identity: "DEFAULT",
      bytes: 0,
      size: "0 bytes",
      live_rows_estimate: 0,
      dead_rows_estimate: 0,
      comment: t.comment,
    })),
    foreignTables: [],
    views: description.views
      .filter((v) => included(v.schema))
      .map((v) => ({
        id: model.tableId(v),
        schema: v.schema,
        name: v.name,
        is_updatable: false,
        comment: v.comment,
      })),
    materializedViews: [],
    columns: tables.flatMap((t) =>
      t.columns.map((c) => {
        const { format_schema, ...column } = model.column(t, c);
        return { ...column, type_schema: format_schema, enums: [...column.enums] };
      }),
    ),
    primaryKeys: tables.flatMap((t) => model.table(t, false).primary_keys),
    relationships: model.foreignKeys
      .filter(({ table, references }) => included(table.schema) && included(references.schema))
      .map(({ table, constraint, references }) => ({
        foreign_key_name: constraint.name,
        schema: table.schema,
        relation: table.name,
        columns: [...constraint.columns],
        is_one_to_one: table.constraints.some(
          (k) =>
            (k.type === "p" || k.type === "u") && k.columns.join() === constraint.columns.join(),
        ),
        referenced_schema: references.schema,
        referenced_relation: references.table,
        referenced_columns: [...references.columns],
      })),
    functions: [],
    types: model.types().map((t) => ({ ...t, enums: [...t.enums], type_relation_id: null })),
    rpcFunctions: [],
  };
};

// Unformatted like `supabase gen types`, which keeps `oxfmt` out of the bundle; no generator spawns.
const host: Host = { cwd: ".", env: {}, format: (code) => Promise.resolve(code) };

/** TypeScript types for `schemas`, from the generator `supabase gen types` and postgres-meta use. */
export const typescript = Effect.fn("SparkMeta.typescript")(function* (
  model: Model,
  schemas: ReadonlyArray<string>,
) {
  const language = findLanguage("typescript");
  if (language === undefined)
    return yield* new SparkTypegenError({ message: "@supabase/typegen has no typescript" });
  return yield* Effect.tryPromise({
    try: (signal) => language.generate(generatorMetadata(model, schemas), {}, { ...host, signal }),
    catch: (cause) =>
      new SparkTypegenError({
        message: `failed to generate typescript types: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
});
