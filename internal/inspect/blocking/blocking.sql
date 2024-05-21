SELECT
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
WHERE NOT bl.granted
