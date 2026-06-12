/**
 * Internal Postgres schemas the `inspect db` queries exclude, and the LIKE-escape
 * helper that turns them into `LIKE ANY($1)` exclusion patterns.
 *
 * 1:1 port of Go's `utils.InternalSchemas` (`apps/cli-go/pkg/migration/dump.go:21-53`)
 * and `reset.LikeEscapeSchema` (`apps/cli-go/internal/db/reset/reset.go:259-266`).
 * The order is preserved verbatim because the escaped array is passed straight
 * through to `LIKE ANY($1)`, where order is observable in nothing but is kept
 * identical to avoid any drift from the Go source.
 */
export const LEGACY_INTERNAL_SCHEMAS: ReadonlyArray<string> = [
  "information_schema",
  "pg_*", // Wildcard pattern follows pg_dump
  // Initialised by supabase/postgres image and owned by postgres role
  "_analytics",
  "_realtime",
  "_supavisor",
  "auth",
  "etl",
  "extensions",
  "pgbouncer",
  "realtime",
  "storage",
  "supabase_functions",
  "supabase_migrations",
  // Owned by extensions
  "cron",
  "dbdev",
  "graphql",
  "graphql_public",
  "net",
  "pgmq",
  "pgsodium",
  "pgsodium_masks",
  "pgtle",
  "repack",
  "tiger",
  "tiger_data",
  "timescaledb_*",
  "_timescaledb_*",
  "topology",
  "vault",
];

/**
 * Escapes each schema name into a SQL `LIKE` pattern, treating `_` as a literal
 * underscore (`\_`) and `*` as the any-character wildcard (`%`). Mirrors Go's
 * `strings.NewReplacer("_", "\\_", "*", "%")` — both replacements are applied to
 * the original string, and since `_`→`\_` introduces only a backslash (not a `*`)
 * and `*`→`%` introduces only a `%`, sequential JS replaces are equivalent.
 */
export function legacyLikeEscapeSchema(schemas: ReadonlyArray<string>): ReadonlyArray<string> {
  return schemas.map((schema) => schema.replace(/_/g, "\\_").replace(/\*/g, "%"));
}
