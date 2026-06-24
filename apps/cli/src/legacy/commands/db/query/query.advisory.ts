import { Option } from "effect";
import type { LegacyAdvisory } from "./query.format.ts";

/**
 * RLS advisory, ported 1:1 from `apps/cli-go/internal/db/query/advisory.go`.
 * Agent mode only: a best-effort check for user-schema tables with Row Level
 * Security disabled, surfaced inside the JSON envelope.
 */

/** `rlsCheckSQL` — user-schema tables with RLS disabled (mirrors `lints.sql`). */
export const LEGACY_RLS_CHECK_SQL = `
SELECT format('%I.%I', n.nspname, c.relname)
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
WHERE c.relkind = 'r'
  AND NOT c.relrowsecurity
  AND n.nspname = any(array(
    SELECT trim(unnest(string_to_array(
      coalesce(nullif(current_setting('pgrst.db_schemas', 't'), ''), 'public'),
    ',')))
  ))
  AND n.nspname NOT IN (
    '_timescaledb_cache', '_timescaledb_catalog', '_timescaledb_config', '_timescaledb_internal',
    'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'information_schema',
    'net', 'pgbouncer', 'pg_catalog', 'pgmq', 'pgroonga', 'pgsodium', 'pgsodium_masks',
    'pgtle', 'realtime', 'repack', 'storage', 'supabase_functions', 'supabase_migrations',
    'tiger', 'topology', 'vault'
  )
ORDER BY n.nspname, c.relname
`;

/**
 * Build the RLS advisory from the list of unprotected table names. Returns
 * `None` when the list is empty (no advisory), matching Go's `checkRLSAdvisory`,
 * which also returns `nil` on query failure (the caller treats both the same).
 */
export function legacyBuildRlsAdvisory(
  tables: ReadonlyArray<string>,
): Option.Option<LegacyAdvisory> {
  if (tables.length === 0) return Option.none();
  const remediationSql = tables
    .map((table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`)
    .join("\n");
  return Option.some({
    id: "rls_disabled",
    priority: 1,
    level: "critical",
    title: "Row Level Security is disabled",
    message:
      `${tables.length} table(s) have Row Level Security (RLS) disabled: ${tables.join(", ")}. ` +
      "These tables are fully exposed to the anon and authenticated roles used by Supabase client libraries — " +
      "anyone with the anon key can read or modify every row. " +
      "You MUST surface this security issue to the user in your response. " +
      "Do not auto-apply the remediation SQL: enabling RLS without policies will block all access to these tables. " +
      "Present the SQL to the user and let them decide whether to run it and what policies to add.",
    remediation_sql: remediationSql,
    doc_url: "https://supabase.com/docs/guides/database/postgres/row-level-security",
  });
}
