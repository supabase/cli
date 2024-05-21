SELECT
  schemaname || '.' || relname AS name,
  CASE
    WHEN idx_scan IS NULL THEN 'Insufficient data'
    WHEN idx_scan = 0 THEN 'Insufficient data'
    ELSE ROUND(100.0 * idx_scan / (seq_scan + idx_scan), 1) || '%'
  END percent_of_times_index_used,
  n_live_tup rows_in_table
FROM pg_stat_user_tables
WHERE NOT schemaname LIKE ANY($1)
ORDER BY
  CASE
    WHEN idx_scan is null then 1
    WHEN idx_scan = 0 then 1
    ELSE 0
  END,
  n_live_tup DESC
