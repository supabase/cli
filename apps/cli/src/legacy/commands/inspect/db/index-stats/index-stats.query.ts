import {
  legacyInspectBool,
  legacyInspectInt,
  legacyInspectText,
  type LegacyInspectQuerySpec,
} from "../legacy-inspect-query.ts";
import { LEGACY_INTERNAL_SCHEMAS, legacyLikeEscapeSchema } from "../legacy-inspect-schemas.ts";

// Verbatim from `apps/cli-go/internal/inspect/index_stats/index_stats.sql`.
const SQL = `-- Combined index statistics: size, usage percent, seq scans, mark unused, expose table + columns
WITH idx_sizes AS (
  SELECT
    i.indexrelid AS oid,
    FORMAT('%I.%I', n.nspname, c.relname) AS name,
    FORMAT('%I.%I', tn.nspname, tc.relname) AS table_name,
    (
      SELECT STRING_AGG(pg_get_indexdef(i.indexrelid, ord::int, false), ',' ORDER BY ord)
      FROM unnest(i.indkey::int[]) WITH ORDINALITY AS k(attnum, ord)
    ) AS columns,
    pg_relation_size(i.indexrelid) AS index_size_bytes
  FROM pg_stat_user_indexes ui
  JOIN pg_index i ON ui.indexrelid = i.indexrelid
  JOIN pg_class c ON ui.indexrelid = c.oid
  JOIN pg_namespace n ON c.relnamespace = n.oid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_namespace tn ON tn.oid = tc.relnamespace
  WHERE NOT n.nspname LIKE ANY($1)
),
idx_usage AS (
  SELECT
    indexrelid AS oid,
    idx_scan::bigint AS idx_scans
  FROM pg_stat_user_indexes ui
  WHERE NOT schemaname LIKE ANY($1)
),
seq_usage AS (
  SELECT
    relid AS oid,
    seq_scan::bigint AS seq_scans
  FROM pg_stat_user_tables
  WHERE NOT schemaname LIKE ANY($1)
),
usage_pct AS (
  SELECT
    u.oid,
    CASE
      WHEN u.idx_scans IS NULL OR u.idx_scans = 0 THEN 0
      WHEN s.seq_scans IS NULL THEN 100
      ELSE ROUND(100.0 * u.idx_scans / (s.seq_scans + u.idx_scans), 1)
    END AS percent_used
  FROM idx_usage u
  LEFT JOIN seq_usage s ON s.oid = u.oid
)
SELECT
  s.name,
  s.table_name AS "table",
  s.columns,
  pg_size_pretty(s.index_size_bytes) AS size,
  COALESCE(up.percent_used, 0)::text || '%' AS percent_used,
  COALESCE(u.idx_scans, 0) AS index_scans,
  COALESCE(sq.seq_scans, 0) AS seq_scans,
  CASE WHEN COALESCE(u.idx_scans, 0) = 0 THEN true ELSE false END AS unused
FROM idx_sizes s
LEFT JOIN idx_usage u ON u.oid = s.oid
LEFT JOIN seq_usage sq ON sq.oid = s.oid
LEFT JOIN usage_pct up ON up.oid = s.oid
ORDER BY s.index_size_bytes DESC`;

/**
 * `inspect db index-stats` — combined index size, usage percent, scan counts,
 * and unused status. Port of `apps/cli-go/internal/inspect/index_stats/index_stats.go`.
 * Also the routed query for the deprecated index/table aliases.
 */
export const legacyIndexStatsSpec: LegacyInspectQuerySpec = {
  name: "index-stats",
  sql: SQL,
  params: () => [legacyLikeEscapeSchema(LEGACY_INTERNAL_SCHEMAS)],
  headers: [
    "Name",
    "Table",
    "Columns",
    "Size",
    "Percent used",
    "Index scans",
    "Seq scans",
    "Unused",
  ],
  project: (row) => [
    legacyInspectText(row["name"]),
    legacyInspectText(row["table"]),
    legacyInspectText(row["columns"]),
    legacyInspectText(row["size"]),
    legacyInspectText(row["percent_used"]),
    legacyInspectInt(row["index_scans"]),
    legacyInspectInt(row["seq_scans"]),
    legacyInspectBool(row["unused"]),
  ],
};
