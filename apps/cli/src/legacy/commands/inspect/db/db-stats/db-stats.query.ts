import { legacyInspectText, type LegacyInspectQuerySpec } from "../legacy-inspect-query.ts";
import { LEGACY_INTERNAL_SCHEMAS, legacyLikeEscapeSchema } from "../legacy-inspect-schemas.ts";

// Verbatim from `apps/cli-go/internal/inspect/db_stats/db_stats.sql`.
const SQL = `WITH total_objects AS (
  SELECT c.relkind, pg_size_pretty(SUM(pg_relation_size(c.oid))) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('i', 'r', 't') AND NOT n.nspname LIKE ANY($1)
  GROUP BY c.relkind
), cache_hit AS (
  SELECT
    'i' AS relkind,
    ROUND(SUM(idx_blks_hit)::numeric / nullif(SUM(idx_blks_hit + idx_blks_read), 0), 2) AS ratio
  FROM pg_statio_user_indexes
  WHERE NOT schemaname LIKE ANY($1)
    UNION
  SELECT
    't' AS relkind,
    /*
      Handle column names for both PG15 and 17
    */
    ROUND(
      (
        SUM(
          COALESCE(
            (to_jsonb(s) ->> 'rel_blks_hit')::bigint,
            (to_jsonb(s) ->> 'heap_blks_hit')::bigint,
            0
          )
        )::numeric
        /
        nullif(
          SUM(
            COALESCE(
              (to_jsonb(s) ->> 'rel_blks_hit')::bigint,
              (to_jsonb(s) ->> 'heap_blks_hit')::bigint,
              0
            )
            +
            COALESCE(
              (to_jsonb(s) ->> 'rel_blks_read')::bigint,
              (to_jsonb(s) ->> 'heap_blks_read')::bigint,
              0
            )
          ),
          0
        )
      ),
      2
    ) AS ratio
  FROM pg_statio_user_tables s
  WHERE NOT schemaname LIKE ANY($1)
)
SELECT
  pg_size_pretty(pg_database_size($2)) AS database_size,
  COALESCE((SELECT size FROM total_objects WHERE relkind = 'i'), '0 bytes') AS total_index_size,
  COALESCE((SELECT size FROM total_objects WHERE relkind = 'r'), '0 bytes') AS total_table_size,
  COALESCE((SELECT size FROM total_objects WHERE relkind = 't'), '0 bytes') AS total_toast_size,
  COALESCE((SELECT (now() - stats_reset)::text FROM extensions.pg_stat_statements_info), 'N/A') AS time_since_stats_reset,
  (SELECT COALESCE(ratio::text, 'N/A') FROM cache_hit WHERE relkind = 'i') AS index_hit_rate,
  (SELECT COALESCE(ratio::text, 'N/A') FROM cache_hit WHERE relkind = 't') AS table_hit_rate,
  COALESCE((SELECT pg_size_pretty(SUM(size)) FROM pg_ls_waldir()), '0 bytes') AS wal_size`;

/**
 * `inspect db db-stats` — cache hit rates, total sizes, and WAL size.
 * Port of `apps/cli-go/internal/inspect/db_stats/db_stats.go`. The leading
 * `Name` column is the resolved database name, injected per row (not a query
 * column); the query takes `$1` = escaped internal schemas, `$2` = database name.
 */
export const legacyDbStatsSpec: LegacyInspectQuerySpec = {
  name: "db-stats",
  sql: SQL,
  params: (cfg) => [legacyLikeEscapeSchema(LEGACY_INTERNAL_SCHEMAS), cfg.conn.database],
  headers: [
    "Name",
    "Database Size",
    "Total Index Size",
    "Total Table Size",
    "Total Toast Size",
    "Time Since Stats Reset",
    "Index Hit Rate",
    "Table Hit Rate",
    "WAL Size",
  ],
  project: (row, cfg) => [
    cfg.conn.database,
    legacyInspectText(row["database_size"]),
    legacyInspectText(row["total_index_size"]),
    legacyInspectText(row["total_table_size"]),
    legacyInspectText(row["total_toast_size"]),
    legacyInspectText(row["time_since_stats_reset"]),
    legacyInspectText(row["index_hit_rate"]),
    legacyInspectText(row["table_hit_rate"]),
    legacyInspectText(row["wal_size"]),
  ],
};
