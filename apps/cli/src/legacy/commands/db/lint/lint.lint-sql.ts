/**
 * SQL constants for `db lint`, ported verbatim from the Go reference so the
 * statements sent to Postgres byte-match.
 *
 *   - `LEGACY_ENABLE_PGSQL_CHECK` — `internal/db/lint/lint.go:20`.
 *   - `LEGACY_CHECK_SCHEMA_SCRIPT` — `internal/db/lint/templates/check.sql`,
 *     the per-schema `plpgsql_check_function` mass-check.
 *   - `LEGACY_LIST_SCHEMAS_SQL` + `LEGACY_MANAGED_SCHEMAS` —
 *     `pkg/migration/queries/list.sql` and `pkg/migration/drop.go:19-31`, used
 *     when `--schema` is omitted (Go's `migration.ListUserSchemas`). The
 *     `\_` / `pg\_%` escapes are preserved exactly — they are `LIKE` patterns.
 */

export const LEGACY_ENABLE_PGSQL_CHECK = "CREATE EXTENSION IF NOT EXISTS plpgsql_check";

export const LEGACY_CHECK_SCHEMA_SCRIPT = `-- Ref: https://github.com/okbob/plpgsql_check#mass-check
SELECT p.proname, plpgsql_check_function(p.oid, format:='json')
FROM pg_catalog.pg_namespace n
JOIN pg_catalog.pg_proc p ON pronamespace = n.oid
JOIN pg_catalog.pg_language l ON p.prolang = l.oid
WHERE l.lanname = 'plpgsql' AND p.prorettype <> 2279 AND n.nspname = $1::text;
`;

export const LEGACY_LIST_SCHEMAS_SQL = `-- List user defined schemas, excluding
--  Extension created schemas
--  Supabase managed schemas
select pn.nspname
from pg_namespace pn
left join pg_depend pd on pd.objid = pn.oid
where pd.deptype is null
  and not pn.nspname like any($1)
  and pn.nspowner::regrole::text != 'supabase_admin'
order by pn.nspname`;

/**
 * Postgres-managed schemas excluded from `ListUserSchemas` (`drop.go:19-31`).
 * These are `LIKE` patterns bound as the `$1` text[] parameter — the `\_` /
 * `pg\_%` escapes are intentional.
 */
export const LEGACY_MANAGED_SCHEMAS: ReadonlyArray<string> = [
  String.raw`information\_schema`,
  String.raw`pg\_%`,
  String.raw`\_analytics`,
  String.raw`\_realtime`,
  String.raw`\_supavisor`,
  "pgbouncer",
  "pgmq",
  "pgsodium",
  "pgtle",
  String.raw`supabase\_migrations`,
  "vault",
];
