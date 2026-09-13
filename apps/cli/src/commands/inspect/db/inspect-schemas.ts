/**
 * Internal Postgres schemas the `inspect db` queries exclude, and the LIKE-escape helper that
 * turns them into `LIKE ANY($1)` exclusion patterns. Order has no functional effect but is
 * kept identical to the established list to avoid any drift.
 */
export const INTERNAL_SCHEMAS: ReadonlyArray<string> = [
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
 * Escapes each schema name into a SQL `LIKE` pattern, treating `\` and `_` as
 * literals and `*` as the any-character wildcard (`%`).
 */
export function likeEscapeSchema(schemas: ReadonlyArray<string>): ReadonlyArray<string> {
  return schemas.map((schema) =>
    schema.replace(/[\\_*]/g, (char) => {
      switch (char) {
        case "*":
          return "%";
        case "\\":
          return "\\\\";
        default:
          return "\\_";
      }
    }),
  );
}
