import { Effect, Schema } from "effect";
import {
  LegacyGenTanstackDbDecodeError,
  LegacyGenTanstackDbNoPrimaryKeyError,
  LegacyGenTanstackDbNoTablesError,
  LegacyGenTanstackDbUnsafeNameError,
} from "./tanstack-db.errors.ts";

/**
 * Decodes the PostgREST OpenAPI/Swagger document returned by the Management API's
 * `database/openapi` endpoint (linked/project-id) or by the local stack's
 * `GET /rest/v1/` (--local). Only the `definitions` field is used — everything
 * else (`swagger`, `info`, `paths`, …) is ignored.
 */
const legacyOpenApiPropertyItems = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  format: Schema.optionalKey(Schema.String),
});

const legacyOpenApiProperty = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  format: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
  items: Schema.optionalKey(legacyOpenApiPropertyItems),
});

const legacyOpenApiDefinition = Schema.Struct({
  properties: Schema.optionalKey(Schema.Record(Schema.String, legacyOpenApiProperty)),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
});

const legacyOpenApiDocument = Schema.Struct({
  definitions: Schema.optionalKey(Schema.Record(Schema.String, legacyOpenApiDefinition)),
});

type LegacyOpenApiProperty = typeof legacyOpenApiProperty.Type;
export type LegacyOpenApiDefinition = typeof legacyOpenApiDefinition.Type;

/** Decodes a raw PostgREST OpenAPI JSON body into its table `definitions`. */
export function legacyDecodeOpenApiDefinitions(
  raw: unknown,
): Effect.Effect<Record<string, LegacyOpenApiDefinition>, LegacyGenTanstackDbDecodeError> {
  return Schema.decodeUnknownEffect(legacyOpenApiDocument)(raw).pipe(
    Effect.map((document) => document.definitions ?? {}),
    Effect.catch((cause) =>
      Effect.fail(
        new LegacyGenTanstackDbDecodeError({
          message: `failed to decode database schema: ${String(cause)}`,
        }),
      ),
    ),
  );
}

/**
 * Merges per-schema OpenAPI `definitions` maps (one document is fetched per
 * requested `--schema` value) into a single table map. A table name that
 * exists in more than one requested schema is last-write-wins, in schema
 * request order — an accepted edge case, not a modeled conflict.
 */
export function legacyMergeOpenApiDefinitions(
  documents: ReadonlyArray<Record<string, LegacyOpenApiDefinition>>,
): Record<string, LegacyOpenApiDefinition> {
  const merged: Record<string, LegacyOpenApiDefinition> = {};
  for (const document of documents) {
    for (const [tableName, definition] of Object.entries(document)) {
      merged[tableName] = definition;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Name sanitizers — ported from the `tanstack-db` block registry
// (supabase/supabase apps/ui-library/app/api/registry/tanstack-db/utils.ts),
// adapted to fail with a typed error instead of a bare `Error`.
// ---------------------------------------------------------------------------

const VALID_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function legacySanitizeIdentifier(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(sanitized)) sanitized = `_${sanitized}`;
  sanitized = sanitized.replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "_";

  if (!VALID_IDENTIFIER_RE.test(sanitized)) {
    throw new LegacyGenTanstackDbUnsafeNameError({
      message: `cannot safely map name "${name}" to a valid identifier: names must contain only letters, digits, and underscores`,
    });
  }
  return sanitized;
}

function legacyToPascalCase(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

function legacyToCamelCase(value: string): string {
  const pascal = legacyToPascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * PostgREST embeds `Note:\nThis is a Primary Key.<pk/>` in a primary-key
 * column's OpenAPI `description`. Falls back to a column literally named
 * `id` when no column carries that hint.
 */
function legacyFindPrimaryKeys(
  properties: Record<string, LegacyOpenApiProperty>,
): ReadonlyArray<string> {
  const primaryKeys = Object.entries(properties)
    .filter(([, prop]) => prop.description?.toLowerCase().includes("primary key") === true)
    .map(([name]) => name);

  if (primaryKeys.length === 0 && properties["id"] !== undefined) {
    return ["id"];
  }
  return primaryKeys;
}

function legacyOpenApiItemTypeToZod(item: { type?: string; format?: string } | undefined): string {
  if (item === undefined) return "z.unknown()";
  switch (item.type) {
    case "string":
      return item.format === "uuid" ? "z.string().uuid()" : "z.string()";
    case "integer":
      return "z.number().int()";
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    default:
      return "z.unknown()";
  }
}

function legacyOpenApiTypeToZod(prop: LegacyOpenApiProperty, isRequired: boolean): string {
  let zodType: string;
  switch (prop.type) {
    case "string":
      if (prop.format === "uuid") {
        zodType = "z.string().uuid()";
      } else if (prop.format === "date-time" || prop.format === "timestamp with time zone") {
        zodType = "z.string()";
      } else if (prop.enum !== undefined && prop.enum.length > 0) {
        const enumValues = prop.enum.map((value) => `'${value.replaceAll("'", "\\'")}'`).join(", ");
        zodType = `z.enum([${enumValues}])`;
      } else {
        zodType = "z.string()";
      }
      break;
    case "integer":
      zodType = "z.number().int()";
      break;
    case "number":
      zodType = "z.number()";
      break;
    case "boolean":
      zodType = "z.boolean()";
      break;
    case "array":
      zodType = `z.array(${legacyOpenApiItemTypeToZod(prop.items)})`;
      break;
    case "object":
      zodType = "z.record(z.unknown())";
      break;
    default:
      zodType = "z.unknown()";
  }
  return isRequired ? zodType : `${zodType}.nullable()`;
}

// ---------------------------------------------------------------------------
// Content generation — one Zod schema + one TanStack DB collection per table,
// combined into a single generated file.
// ---------------------------------------------------------------------------

function legacyGenerateSchemaLines(
  tableName: string,
  definition: LegacyOpenApiDefinition,
): Array<string> {
  const safeTableId = legacySanitizeIdentifier(tableName);
  const typeName = legacyToPascalCase(safeTableId);
  const schemaName = `${legacyToCamelCase(safeTableId)}Schema`;
  const properties = definition.properties ?? {};
  const required = definition.required ?? [];

  const lines = [`// ${typeName} schema`, `export const ${schemaName} = z.object({`];
  for (const [propName, prop] of Object.entries(properties)) {
    const zodType = legacyOpenApiTypeToZod(prop, required.includes(propName));
    lines.push(`  ${JSON.stringify(propName)}: ${zodType},`);
  }
  lines.push("})", "", `export type ${typeName} = z.infer<typeof ${schemaName}>`);
  return lines;
}

function legacyGenerateCollectionLines(
  tableName: string,
  definition: LegacyOpenApiDefinition,
): Array<string> {
  const safeTableId = legacySanitizeIdentifier(tableName);
  const collectionName = `${legacyToCamelCase(safeTableId)}Collection`;
  const schemaName = `${legacyToCamelCase(safeTableId)}Schema`;
  const properties = definition.properties ?? {};
  const primaryKeys = legacyFindPrimaryKeys(properties);

  if (primaryKeys.length === 0) {
    throw new LegacyGenTanstackDbNoPrimaryKeyError({
      message: `table "${tableName}" has no primary key columns; TanStack DB collections require at least one primary key`,
    });
  }

  const keysLiteral = `[${primaryKeys.map((key) => JSON.stringify(key)).join(", ")}]`;

  return [
    `export const ${collectionName} = createCollection(supabaseCollectionOptions({`,
    `  tableName: ${JSON.stringify(tableName)},`,
    `  schema: ${schemaName},`,
    `  keys: ${keysLiteral},`,
    "  supabase,",
    "  realtime: true,",
    "}))",
  ];
}

const LEGACY_TANSTACK_DB_FILE_HEADER = [
  "// Generated by `supabase gen tanstack-db`. Do not edit by hand — rerun the",
  "// command to regenerate after a schema change.",
  'import { z } from "zod";',
  'import { createClient } from "@supabase/supabase-js";',
  'import { createCollection } from "@tanstack/db";',
  'import { supabaseCollectionOptions } from "@supabase-labs/tanstack-db";',
  "",
  "// Requires SUPABASE_URL and SUPABASE_ANON_KEY to be set.",
  "const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);",
];

function legacyGenerateTanstackDbFileContent(
  definitions: Record<string, LegacyOpenApiDefinition>,
): string {
  const tables = Object.entries(definitions).filter(([name]) => !name.startsWith("_"));
  if (tables.length === 0) {
    throw new LegacyGenTanstackDbNoTablesError({
      message: "no tables found in the selected schema(s)",
    });
  }

  const body = tables.flatMap(([tableName, definition]) => [
    "",
    ...legacyGenerateSchemaLines(tableName, definition),
    "",
    ...legacyGenerateCollectionLines(tableName, definition),
  ]);

  return [...LEGACY_TANSTACK_DB_FILE_HEADER, ...body, ""].join("\n");
}

/**
 * Effectful entry point: runs the pure generator and maps any of the three
 * modeled failure modes (unsafe name, missing primary key, no tables) to
 * their typed error. Any other thrown value would be a generator bug, not a
 * modeled failure — it is still surfaced as `LegacyGenTanstackDbUnsafeNameError`
 * rather than defect, since the generator never throws anything else on
 * purpose.
 */
export function legacyGenerateTanstackDbFile(
  definitions: Record<string, LegacyOpenApiDefinition>,
): Effect.Effect<
  string,
  | LegacyGenTanstackDbUnsafeNameError
  | LegacyGenTanstackDbNoPrimaryKeyError
  | LegacyGenTanstackDbNoTablesError
> {
  return Effect.try({
    try: () => legacyGenerateTanstackDbFileContent(definitions),
    catch: (cause) => {
      if (
        cause instanceof LegacyGenTanstackDbUnsafeNameError ||
        cause instanceof LegacyGenTanstackDbNoPrimaryKeyError ||
        cause instanceof LegacyGenTanstackDbNoTablesError
      ) {
        return cause;
      }
      return new LegacyGenTanstackDbUnsafeNameError({
        message: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });
}
