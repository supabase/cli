import { Lock, LOCK_SCHEMA_URL } from "@supabase/stack/effect";
import { JsonSchema, Schema } from "effect";

/** The draft-07 JSON Schema of `supabase/supabase.lock`, rendered from the stack's `Lock` schema. */
export const lockSchemaDocument = () => {
  const { schema, definitions } = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(Lock));
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    $id: LOCK_SCHEMA_URL,
    title: "supabase.lock",
    description: "The service versions that supabase start pins in supabase/supabase.lock.",
    ...schema,
    definitions,
  };
};

/** The path under `apps/docs/public` that serves the schema published at `url`. */
export const publishedSchemaPath = (url: string): string => new URL(url).pathname;
