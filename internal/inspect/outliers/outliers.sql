SELECT
  (interval '1 millisecond' * total_exec_time)::text AS total_exec_time,
  to_char((total_exec_time/sum(total_exec_time) OVER()) * 100, 'FM90D0') || '%'  AS prop_exec_time,
  to_char(calls, 'FM999G999G999G990') AS ncalls,
  (interval '1 millisecond' * (blk_read_time + blk_write_time))::text AS sync_io_time,
  query
FROM pg_stat_statements WHERE userid = (SELECT usesysid FROM pg_user WHERE usename = current_user LIMIT 1)
ORDER BY total_exec_time DESC
LIMIT 10
