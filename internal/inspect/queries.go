package inspect

const BLOAT_QUERY = `WITH constants AS (
  SELECT current_setting('block_size')::numeric AS bs, 23 AS hdr, 4 AS ma
), bloat_info AS (
  SELECT
    ma,bs,schemaname,tablename,
    (datawidth+(hdr+ma-(case when hdr%ma=0 THEN ma ELSE hdr%ma END)))::numeric AS datahdr,
    (maxfracsum*(nullhdr+ma-(case when nullhdr%ma=0 THEN ma ELSE nullhdr%ma END))) AS nullhdr2
  FROM (
    SELECT
      schemaname, tablename, hdr, ma, bs,
      SUM((1-null_frac)*avg_width) AS datawidth,
      MAX(null_frac) AS maxfracsum,
      hdr+(
        SELECT 1+count(*)/8
        FROM pg_stats s2
        WHERE null_frac<>0 AND s2.schemaname = s.schemaname AND s2.tablename = s.tablename
      ) AS nullhdr
    FROM pg_stats s, constants
    GROUP BY 1,2,3,4,5
  ) AS foo
), table_bloat AS (
  SELECT
    schemaname, tablename, cc.relpages, bs,
    CEIL((cc.reltuples*((datahdr+ma-
      (CASE WHEN datahdr%ma=0 THEN ma ELSE datahdr%ma END))+nullhdr2+4))/(bs-20::float)) AS otta
  FROM bloat_info
  JOIN pg_class cc ON cc.relname = bloat_info.tablename
  JOIN pg_namespace nn ON cc.relnamespace = nn.oid AND nn.nspname = bloat_info.schemaname AND nn.nspname <> 'information_schema'
), index_bloat AS (
  SELECT
    schemaname, tablename, bs,
    COALESCE(c2.relname,'?') AS iname, COALESCE(c2.reltuples,0) AS ituples, COALESCE(c2.relpages,0) AS ipages,
    COALESCE(CEIL((c2.reltuples*(datahdr-12))/(bs-20::float)),0) AS iotta -- very rough approximation, assumes all cols
  FROM bloat_info
  JOIN pg_class cc ON cc.relname = bloat_info.tablename
  JOIN pg_namespace nn ON cc.relnamespace = nn.oid AND nn.nspname = bloat_info.schemaname AND nn.nspname <> 'information_schema'
  JOIN pg_index i ON indrelid = cc.oid
  JOIN pg_class c2 ON c2.oid = i.indexrelid
)
SELECT
  type, schemaname, object_name, bloat, pg_size_pretty(raw_waste) as waste
FROM
(SELECT
  'table' as type,
  schemaname,
  tablename as object_name,
  ROUND(CASE WHEN otta=0 THEN 0.0 ELSE table_bloat.relpages/otta::numeric END,1) AS bloat,
  CASE WHEN relpages < otta THEN '0' ELSE (bs*(table_bloat.relpages-otta)::bigint)::bigint END AS raw_waste
FROM
  table_bloat
    UNION
SELECT
  'index' as type,
  schemaname,
  tablename || '::' || iname as object_name,
  ROUND(CASE WHEN iotta=0 OR ipages=0 THEN 0.0 ELSE ipages/iotta::numeric END,1) AS bloat,
  CASE WHEN ipages < iotta THEN '0' ELSE (bs*(ipages-iotta))::bigint END AS raw_waste
FROM
  index_bloat) bloat_summary
WHERE NOT schemaname LIKE ANY($1)
ORDER BY raw_waste DESC, bloat DESC`

// Ref: https://github.com/heroku/heroku-pg-extras/blob/main/commands/blocking.js#L7
const BLOCKING_QUERY = `SELECT
  bl.pid AS blocked_pid,
  ka.query AS blocking_statement,
  age(now(), ka.query_start)::text AS blocking_duration,
  kl.pid AS blocking_pid,
  a.query AS blocked_statement,
  age(now(), a.query_start)::text AS blocked_duration
FROM pg_catalog.pg_locks bl
JOIN pg_catalog.pg_stat_activity a
	ON bl.pid = a.pid
JOIN pg_catalog.pg_locks kl
JOIN pg_catalog.pg_stat_activity ka
	ON kl.pid = ka.pid
	ON bl.transactionid = kl.transactionid AND bl.pid != kl.pid
WHERE NOT bl.granted`

// Ref: https://github.com/heroku/heroku-pg-extras/blob/main/commands/cache_hit.js#L7
const CACHE_QUERY = `SELECT
'index hit rate' AS name,
(sum(idx_blks_hit)) / nullif(sum(idx_blks_hit + idx_blks_read),0) AS ratio
FROM pg_statio_user_indexes
UNION ALL
SELECT
'table hit rate' AS name,
sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read),0) AS ratio
FROM pg_statio_user_tables`

const CALLS_QUERY = `SELECT
  query,
  (interval '1 millisecond' * total_exec_time)::text AS total_exec_time,
  to_char((total_exec_time/sum(total_exec_time) OVER()) * 100, 'FM90D0') || '%'  AS prop_exec_time,
  to_char(calls, 'FM999G999G990') AS ncalls,
  (interval '1 millisecond' * (blk_read_time + blk_write_time))::text AS sync_io_time
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 10`

const INDEX_SIZE_QUERY = `SELECT c.relname AS name,
pg_size_pretty(sum(c.relpages::bigint*8192)::bigint) AS size
FROM pg_class c
LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE NOT n.nspname LIKE ANY($1)
AND c.relkind = 'i'
GROUP BY c.relname
ORDER BY sum(c.relpages) DESC`

const INDEX_USAGE_QUERY = `SELECT relname,
CASE
  WHEN idx_scan IS NULL THEN 'Insufficient data'
  WHEN idx_scan = 0 THEN 'Insufficient data'
  ELSE (100 * idx_scan / (seq_scan + idx_scan))::text
END percent_of_times_index_used,
n_live_tup rows_in_table
FROM
pg_stat_user_tables
ORDER BY
CASE
  WHEN idx_scan is null then 1
  WHEN idx_scan = 0 then 1
  ELSE 0
END,
n_live_tup DESC`

const LOCKS_QUERY = `SELECT
pg_stat_activity.pid,
COALESCE(pg_class.relname, 'null') AS relname,
COALESCE(pg_locks.transactionid, 'null') AS transactionid,
pg_locks.granted,
pg_stat_activity.query,
age(now(),pg_stat_activity.query_start) AS age
FROM pg_stat_activity, pg_locks LEFT OUTER JOIN pg_class ON (pg_locks.relation = pg_class.oid)
WHERE pg_stat_activity.query <> '<insufficient privilege>'
AND pg_locks.pid=pg_stat_activity.pid
AND pg_locks.mode = 'ExclusiveLock'
ORDER BY query_start`

const LONG_RUNNING_QUERY = `SELECT
  pid,
  age(now(), pg_stat_activity.query_start)::text AS duration,
  query AS query
FROM
pg_stat_activity
WHERE
pg_stat_activity.query <> ''::text
AND state <> 'idle'
AND now() - pg_stat_activity.query_start > interval '5 minutes'
ORDER BY
now() - pg_stat_activity.query_start DESC`

const OUTLIERS_QUERY = `SELECT
  (interval '1 millisecond' * total_exec_time)::text AS total_exec_time,
  to_char((total_exec_time/sum(total_exec_time) OVER()) * 100, 'FM90D0') || '%'  AS prop_exec_time,
  to_char(calls, 'FM999G999G999G990') AS ncalls,
  (interval '1 millisecond' * (blk_read_time + blk_write_time))::text AS sync_io_time,
  query
FROM pg_stat_statements WHERE userid = (SELECT usesysid FROM pg_user WHERE usename = current_user LIMIT 1)
ORDER BY total_exec_time DESC
LIMIT 10`

const REPLICATION_SLOTS_QUERY = `SELECT
s.slot_name,
s.active,
COALESCE(r.state, 'N/A') as state,
CASE WHEN r.client_addr IS NULL
   THEN 'N/A'
   ELSE r.client_addr::text
END replication_client_address,
GREATEST(0, ROUND((redo_lsn-restart_lsn)/1024/1024/1024, 2)) as replication_lag_gb
FROM pg_control_checkpoint(), pg_replication_slots s
LEFT JOIN pg_stat_replication r ON (r.pid = s.active_pid)`

const ROLE_CONNECTIONS_QUERY = `SELECT
rolname,
(
  SELECT
    count(*)
  FROM
    pg_stat_activity
  WHERE
    pg_roles.rolname = pg_stat_activity.usename
) AS active_connections,
CASE WHEN rolconnlimit = -1 THEN current_setting('max_connections') :: int8
     ELSE rolconnlimit
END AS connection_limit
FROM
pg_roles
ORDER BY 2 DESC`

const SEQ_SCANS_QUERY = `SELECT relname AS name,
seq_scan as count
FROM
pg_stat_user_tables
ORDER BY seq_scan DESC`

const TABLE_INDEX_SIZE_QUERY = `SELECT c.relname AS table,
pg_size_pretty(pg_indexes_size(c.oid)) AS index_size
FROM pg_class c
LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE NOT n.nspname LIKE ANY($1)
AND c.relkind = 'r'
ORDER BY pg_indexes_size(c.oid) DESC`

const TABLE_RECORD_COUNTS_QUERY = `SELECT
relname AS name,
n_live_tup AS estimated_count
FROM
pg_stat_user_tables
ORDER BY
n_live_tup DESC`

const TABLE_SIZE_QUERY = `SELECT c.relname AS name,
pg_size_pretty(pg_table_size(c.oid)) AS size
FROM pg_class c
LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE NOT n.nspname LIKE ANY($1)
AND c.relkind = 'r'
ORDER BY pg_table_size(c.oid) DESC`

const TOTAL_INDEX_SIZE_QUERY = `SELECT pg_size_pretty(sum(c.relpages::bigint*8192)::bigint) AS size
FROM pg_class c
LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE NOT n.nspname LIKE ANY($1)
AND c.relkind = 'i'`

const TOTAL_TABLE_SIZE_QUERY = `SELECT c.relname AS name,
pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
LEFT JOIN pg_namespace n ON (n.oid = c.relnamespace)
WHERE NOT n.nspname LIKE ANY($1)
AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC`

const UNUSED_INDEXES_QUERY = `SELECT
schemaname || '.' || relname AS table,
indexrelname AS index,
pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size,
idx_scan as index_scans
FROM pg_stat_user_indexes ui
JOIN pg_index i ON ui.indexrelid = i.indexrelid
WHERE NOT indisunique AND idx_scan < 50 AND pg_relation_size(relid) > 5 * 8192 AND NOT schemaname LIKE ANY($1)
ORDER BY pg_relation_size(i.indexrelid) / nullif(idx_scan, 0) DESC NULLS FIRST,
pg_relation_size(i.indexrelid) DESC`

const VACUUM_STATS_QUERY = `WITH table_opts AS (
  SELECT
    pg_class.oid, relname, nspname, array_to_string(reloptions, '') AS relopts
  FROM
     pg_class INNER JOIN pg_namespace ns ON relnamespace = ns.oid
), vacuum_settings AS (
  SELECT
    oid, relname, nspname,
    CASE
      WHEN relopts LIKE '%autovacuum_vacuum_threshold%'
        THEN substring(relopts, '.*autovacuum_vacuum_threshold=([0-9.]+).*')::integer
        ELSE current_setting('autovacuum_vacuum_threshold')::integer
      END AS autovacuum_vacuum_threshold,
    CASE
      WHEN relopts LIKE '%autovacuum_vacuum_scale_factor%'
        THEN substring(relopts, '.*autovacuum_vacuum_scale_factor=([0-9.]+).*')::real
        ELSE current_setting('autovacuum_vacuum_scale_factor')::real
      END AS autovacuum_vacuum_scale_factor
  FROM
    table_opts
)
SELECT
  vacuum_settings.nspname AS schema,
  vacuum_settings.relname AS table,
  coalesce(to_char(psut.last_vacuum, 'YYYY-MM-DD HH24:MI'), '') AS last_vacuum,
  coalesce(to_char(psut.last_autovacuum, 'YYYY-MM-DD HH24:MI'), '') AS last_autovacuum,
  to_char(pg_class.reltuples, '9G999G999G999') AS rowcount,
  to_char(psut.n_dead_tup, '9G999G999G999') AS dead_rowcount,
  to_char(autovacuum_vacuum_threshold
       + (autovacuum_vacuum_scale_factor::numeric * pg_class.reltuples), '9G999G999G999') AS autovacuum_threshold,
  CASE
    WHEN autovacuum_vacuum_threshold + (autovacuum_vacuum_scale_factor::numeric * pg_class.reltuples) < psut.n_dead_tup
    THEN 'yes'
    ELSE 'no'
  END AS expect_autovacuum
FROM
  pg_stat_user_tables psut INNER JOIN pg_class ON psut.relid = pg_class.oid
INNER JOIN vacuum_settings ON pg_class.oid = vacuum_settings.oid
WHERE NOT vacuum_settings.nspname LIKE ANY($1)
ORDER BY
  case
    when pg_class.reltuples = -1 then 1
    else 0
  end,
  1`
