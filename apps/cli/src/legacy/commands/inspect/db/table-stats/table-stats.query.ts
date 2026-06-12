import {
  legacyInspectInt,
  legacyInspectText,
  type LegacyInspectQuerySpec,
} from "../legacy-inspect-query.ts";
import { LEGACY_INTERNAL_SCHEMAS, legacyLikeEscapeSchema } from "../legacy-inspect-schemas.ts";

// Verbatim from `apps/cli-go/internal/inspect/table_stats/table_stats.sql`.
const SQL = `SELECT
  ts.name,
  pg_size_pretty(ts.table_size_bytes) AS table_size,
  pg_size_pretty(ts.index_size_bytes) AS index_size,
  pg_size_pretty(ts.total_size_bytes) AS total_size,
  COALESCE(rc.estimated_row_count, 0) AS estimated_row_count,
  COALESCE(rc.seq_scans, 0) AS seq_scans
FROM (
  SELECT
    FORMAT('%I.%I', n.nspname, c.relname) AS name,
    pg_table_size(c.oid) AS table_size_bytes,
    pg_indexes_size(c.oid) AS index_size_bytes,
    pg_total_relation_size(c.oid) AS total_size_bytes
  FROM pg_class c
  LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT n.nspname LIKE ANY($1)
    AND c.relkind = 'r'
) ts
LEFT JOIN (
  SELECT
    FORMAT('%I.%I', schemaname, relname) AS name,
    n_live_tup AS estimated_row_count,
    seq_scan AS seq_scans
  FROM pg_stat_user_tables
  WHERE NOT schemaname LIKE ANY($1)
) rc ON rc.name = ts.name
ORDER BY ts.total_size_bytes DESC`;

/**
 * `inspect db table-stats` — combined table size, index size, and row count.
 * Port of `apps/cli-go/internal/inspect/table_stats/table_stats.go`. Also the
 * routed query for the deprecated `table-sizes` / `table-index-sizes` /
 * `total-table-sizes` aliases (but NOT `table-record-counts`, which Go routes to
 * index-stats — preserved in that alias's handler).
 */
export const legacyTableStatsSpec: LegacyInspectQuerySpec = {
  name: "table-stats",
  sql: SQL,
  params: () => [legacyLikeEscapeSchema(LEGACY_INTERNAL_SCHEMAS)],
  headers: ["Name", "Table size", "Index size", "Total size", "Estimated row count", "Seq scans"],
  project: (row) => [
    legacyInspectText(row["name"]),
    legacyInspectText(row["table_size"]),
    legacyInspectText(row["index_size"]),
    legacyInspectText(row["total_size"]),
    legacyInspectInt(row["estimated_row_count"]),
    legacyInspectInt(row["seq_scans"]),
  ],
};
