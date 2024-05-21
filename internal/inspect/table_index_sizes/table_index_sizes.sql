SELECT
  n.nspname || '.' || c.relname AS table,
  pg_size_pretty(pg_indexes_size(c.oid)) AS index_size
FROM pg_class c
LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE NOT n.nspname LIKE ANY($1)
AND c.relkind = 'r'
ORDER BY pg_indexes_size(c.oid) DESC
