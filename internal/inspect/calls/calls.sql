SELECT
  query,
  (interval '1 millisecond' * total_exec_time)::text AS total_exec_time,
  to_char((total_exec_time/sum(total_exec_time) OVER()) * 100, 'FM90D0') || '%'  AS prop_exec_time,
  to_char(calls, 'FM999G999G990') AS ncalls,
  (interval '1 millisecond' * (
    COALESCE((row_to_json(s)->>'blk_read_time')::numeric, 0) +
    COALESCE((row_to_json(s)->>'blk_write_time')::numeric, 0)
  ))::text AS sync_io_time
FROM pg_stat_statements AS s
ORDER BY calls DESC
LIMIT 10
