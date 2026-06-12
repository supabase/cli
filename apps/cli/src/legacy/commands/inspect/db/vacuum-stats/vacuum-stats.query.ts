import {
  legacyInspectPlainText,
  legacyInspectText,
  type LegacyInspectQuerySpec,
} from "../legacy-inspect-query.ts";
import { LEGACY_INTERNAL_SCHEMAS, legacyLikeEscapeSchema } from "../legacy-inspect-schemas.ts";

// Verbatim from `apps/cli-go/internal/inspect/vacuum_stats/vacuum_stats.sql`.
const SQL = `WITH table_opts AS (
  SELECT
    pg_class.oid, relname, nspname, array_to_string(reloptions, '') AS relopts
  FROM
    pg_class INNER JOIN pg_namespace ns ON relnamespace = ns.oid
), vacuum_settings AS (
  SELECT
    oid, relname, nspname,
    CASE
      WHEN relopts LIKE '%autovacuum_vacuum_threshold%'
        THEN substring(relopts, '.*autovacuum_vacuum_threshold=([0-9.]+).*')::integer
        ELSE current_setting('autovacuum_vacuum_threshold')::integer
      END AS autovacuum_vacuum_threshold,
    CASE
      WHEN relopts LIKE '%autovacuum_vacuum_scale_factor%'
        THEN substring(relopts, '.*autovacuum_vacuum_scale_factor=([0-9.]+).*')::real
        ELSE current_setting('autovacuum_vacuum_scale_factor')::real
      END AS autovacuum_vacuum_scale_factor,
    CASE
      WHEN relopts LIKE '%autovacuum_analyze_threshold%'
        THEN substring(relopts, '.*autovacuum_analyze_threshold=([0-9.]+).*')::integer
        ELSE current_setting('autovacuum_analyze_threshold')::integer
      END AS autovacuum_analyze_threshold,
    CASE
      WHEN relopts LIKE '%autovacuum_analyze_scale_factor%'
        THEN substring(relopts, '.*autovacuum_analyze_scale_factor=([0-9.]+).*')::real
        ELSE current_setting('autovacuum_analyze_scale_factor')::real
      END AS autovacuum_analyze_scale_factor
  FROM
    table_opts
)
SELECT
  FORMAT('%I.%I', vacuum_settings.nspname, vacuum_settings.relname) AS name,
  coalesce(to_char(psut.last_vacuum, 'YYYY-MM-DD HH24:MI'), '') AS last_vacuum,
  coalesce(to_char(psut.last_autovacuum, 'YYYY-MM-DD HH24:MI'), '') AS last_autovacuum,
  coalesce(to_char(psut.last_analyze, 'YYYY-MM-DD HH24:MI'), '') AS last_analyze,
  coalesce(to_char(psut.last_autoanalyze, 'YYYY-MM-DD HH24:MI'), '') AS last_autoanalyze,
  to_char(pg_class.reltuples, '9G999G999G999') AS rowcount,
  to_char(psut.n_dead_tup, '9G999G999G999') AS dead_rowcount,
  to_char(autovacuum_vacuum_threshold
       + (autovacuum_vacuum_scale_factor::numeric * pg_class.reltuples), '9G999G999G999') AS autovacuum_threshold,
  CASE
    WHEN autovacuum_vacuum_threshold + (autovacuum_vacuum_scale_factor::numeric * pg_class.reltuples) < psut.n_dead_tup
    THEN 'yes'
    ELSE 'no'
  END AS expect_autovacuum,
  to_char(autovacuum_analyze_threshold
       + (autovacuum_analyze_scale_factor::numeric * pg_class.reltuples), '9G999G999G999') AS autoanalyze_threshold,
  CASE
    WHEN autovacuum_analyze_threshold + (autovacuum_analyze_scale_factor::numeric * pg_class.reltuples) < psut.n_dead_tup
    THEN 'yes'
    ELSE 'no'
  END AS expect_autoanalyze
FROM
  pg_stat_user_tables psut INNER JOIN pg_class ON psut.relid = pg_class.oid
INNER JOIN vacuum_settings ON pg_class.oid = vacuum_settings.oid
WHERE NOT vacuum_settings.nspname LIKE ANY($1)
ORDER BY
  case
    when pg_class.reltuples = -1 then 1
    else 0
  end,
  1`;

/**
 * `inspect db vacuum-stats` — per-table vacuum statistics.
 * Port of `apps/cli-go/internal/inspect/vacuum_stats/vacuum_stats.go`. The query
 * returns 11 columns but only 9 are rendered (Go drops `autovacuum_threshold`
 * and `autoanalyze_threshold`). The `rowcount` cell has a one-shot `-1` → `No
 * stats` replacement (Go's `strings.Replace(..., 1)`).
 */
export const legacyVacuumStatsSpec: LegacyInspectQuerySpec = {
  name: "vacuum-stats",
  sql: SQL,
  params: () => [legacyLikeEscapeSchema(LEGACY_INTERNAL_SCHEMAS)],
  headers: [
    "Table",
    "Last Vacuum",
    "Last Auto Vacuum",
    "Last Analyze",
    "Last Auto Analyze",
    "Row count",
    "Dead row count",
    "Expect autovacuum?",
    "Expect autoanalyze?",
  ],
  project: (row) => [
    legacyInspectText(row["name"]),
    // Go writes these four timestamp columns as bare `%s|` (no backtick code span,
    // `vacuum_stats.go:53`), so an empty value stays empty rather than `` `` ``.
    legacyInspectPlainText(row["last_vacuum"]),
    legacyInspectPlainText(row["last_autovacuum"]),
    legacyInspectPlainText(row["last_analyze"]),
    legacyInspectPlainText(row["last_autoanalyze"]),
    // One-shot `-1` → `No stats` (JS String.replace with a string replaces only
    // the first occurrence, matching Go's `strings.Replace(..., 1)`).
    legacyInspectText(row["rowcount"]).replace("-1", "No stats"),
    legacyInspectText(row["dead_rowcount"]),
    legacyInspectText(row["expect_autovacuum"]),
    legacyInspectText(row["expect_autoanalyze"]),
  ],
};
