SELECT
  schemaname || '.' || relname AS name,
  seq_scan as count
FROM pg_stat_user_tables
WHERE NOT schemaname LIKE ANY($1)
ORDER BY seq_scan DESC
