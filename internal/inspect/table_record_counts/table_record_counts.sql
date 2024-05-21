SELECT
  schemaname AS schema,
  relname AS name,
  n_live_tup AS estimated_count
FROM pg_stat_user_tables
WHERE NOT schemaname LIKE ANY($1)
ORDER BY n_live_tup DESC
