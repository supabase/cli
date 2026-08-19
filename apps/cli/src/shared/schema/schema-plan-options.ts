import { supabaseProfile } from "@supabase/pg-delta/integrations";

/** Options for `planSchemaFiles` on the schema-first path. Isolated cluster only. */
export const schemaIsolatedPlanOptions = {
  profile: supabaseProfile,
  scope: "database" as const,
  redactSecrets: true,
  isolatedShadow: true,
  seedAssumedSchemas: false,
  allowSameDatabaseIdentity: true,
  strictDataStatements: true,
  reorder: true,
};
