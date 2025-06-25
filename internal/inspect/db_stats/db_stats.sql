WITH total_objects AS (
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
    ROUND(SUM(heap_blks_hit)::numeric / nullif(SUM(heap_blks_hit + heap_blks_read), 0), 2) AS ratio
  FROM pg_statio_user_tables
  WHERE NOT schemaname LIKE ANY($1)
)
SELECT
  pg_size_pretty(pg_database_size($2)) AS database_size,
  (SELECT size FROM total_objects WHERE relkind = 'i') AS total_index_size,
  (SELECT size FROM total_objects WHERE relkind = 'r') AS total_table_size,
  (SELECT size FROM total_objects WHERE relkind = 't') AS total_toast_size,
  (SELECT (now() - stats_reset)::text FROM pg_stat_statements_info) AS time_since_stats_reset,
  (SELECT COALESCE(ratio::text, 'N/A') FROM cache_hit WHERE relkind = 'i') AS index_hit_rate,
  (SELECT COALESCE(ratio::text, 'N/A') FROM cache_hit WHERE relkind = 't') AS table_hit_rate,
  (SELECT pg_size_pretty(SUM(size)) FROM pg_ls_waldir()) AS wal_size
