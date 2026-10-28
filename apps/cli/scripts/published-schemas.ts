import { HOSTED_LOCK_SCHEMA_URL, Lock } from "@supabase/stack/effect";
import { JsonSchema, Predicate, Schema } from "effect";

const DEFINITION_REF_PREFIX = "#/definitions/";

const renameRefs = (node: unknown, renames: ReadonlyMap<string, string>): unknown =>
  Array.isArray(node)
    ? node.map((child) => renameRefs(child, renames))
    : Predicate.isObject(node)
      ? renameRefsIn(node, renames)
      : node;

const renameRefsIn = (
  node: JsonSchema.JsonSchema,
  renames: ReadonlyMap<string, string>,
): JsonSchema.JsonSchema =>
  Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      key === "$ref" && typeof value === "string"
        ? (renames.get(value) ?? value)
        : renameRefs(value, renames),
    ]),
  );

/** Collapses identical definitions onto the first name, since `Lock` renders one per service. */
const dedupeDefinitions = ({ schema, definitions }: JsonSchema.Document<"draft-07">) => {
  const firstByBody = new Map<string, string>();
  const renames = new Map<string, string>();
  const kept: Array<[string, JsonSchema.JsonSchema]> = [];
  for (const [name, definition] of Object.entries(definitions)) {
    const body = JSON.stringify(definition);
    const first = firstByBody.get(body);
    if (first === undefined) {
      firstByBody.set(body, name);
      kept.push([name, definition]);
    } else {
      renames.set(`${DEFINITION_REF_PREFIX}${name}`, `${DEFINITION_REF_PREFIX}${first}`);
    }
  }
  return {
    schema: renameRefsIn(schema, renames),
    definitions: renameRefsIn(Object.fromEntries(kept), renames),
  };
};

/** The draft-07 JSON Schema of `supabase/supabase.lock`, rendered from the stack's `Lock` schema. */
export const lockSchemaDocument = () => {
  const { schema, definitions } = dedupeDefinitions(
    JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(Lock)),
  );
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    $id: HOSTED_LOCK_SCHEMA_URL,
    title: "supabase.lock",
    description: "The service versions that supabase start pins in supabase/supabase.lock.",
    ...schema,
    definitions,
  };
};

/** The path under `apps/docs/public` that serves the schema published at `url`. */
export const publishedSchemaPath = (url: string): string => new URL(url).pathname;
