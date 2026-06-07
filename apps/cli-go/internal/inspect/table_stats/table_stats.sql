SELECT
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
ORDER BY ts.total_size_bytes DESC
