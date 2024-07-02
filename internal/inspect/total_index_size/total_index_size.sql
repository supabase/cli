SELECT
  pg_size_pretty(sum(c.relpages::bigint*8192)::bigint) AS size
FROM pg_class c
LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE NOT n.nspname LIKE ANY($1)
AND c.relkind = 'i'
