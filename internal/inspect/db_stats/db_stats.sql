SELECT
  'postgres' AS name,
  pg_size_pretty(pg_database_size('postgres'))                                                                            AS database_size,
  (SELECT pg_size_pretty(SUM(pg_relation_size(c.oid)))
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'i')                                         AS total_index_size,
  (SELECT pg_size_pretty(SUM(pg_relation_size(c.oid)))
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r')                                         AS total_table_size,
  (SELECT pg_size_pretty(SUM(pg_relation_size(c.oid)))
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 't')                                         AS total_toast_size,
  (SELECT (now() - stats_reset)::text FROM pg_stat_statements_info)                                                           AS time_since_stats_reset,
  (SELECT ROUND(SUM(idx_blks_hit)::numeric / nullif(SUM(idx_blks_hit + idx_blks_read),0),2)
   FROM pg_statio_user_indexes)                                                                                               AS index_hit_rate,
  (SELECT ROUND(SUM(heap_blks_hit)::numeric / nullif(SUM(heap_blks_hit + heap_blks_read),0),2)
   FROM pg_statio_user_tables)                                                                                                AS table_hit_rate,
   (SELECT pg_size_pretty(SUM(size)) FROM pg_ls_waldir())                                                                    AS wal_size