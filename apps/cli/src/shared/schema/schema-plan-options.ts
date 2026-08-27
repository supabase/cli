import { supabaseProfile } from "@supabase/pg-delta/integrations";

/** Isolated-cluster `planSchemaFiles` options. `reorder` escalates after default order + reconnect. */
export const schemaIsolatedPlanOptions = {
  profile: supabaseProfile,
  scope: "database" as const,
  redactSecrets: true,
  isolatedShadow: true,
  seedAssumedSchemas: false,
  allowSameDatabaseIdentity: true,
  strictDataStatements: true,
  reorder: true,
  connectionReuse: "reconnect-on-stuck" as const,
};
