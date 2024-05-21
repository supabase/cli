SELECT
  n.nspname AS schema,
  c.relname AS name,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE NOT n.nspname LIKE ANY($1)
AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC
