SELECT
  pid,
  age(now(), pg_stat_activity.query_start)::text AS duration,
  query AS query
FROM
  pg_stat_activity
WHERE
  pg_stat_activity.query <> ''::text
  AND state <> 'idle'
  AND age(now(), pg_stat_activity.query_start) > interval '5 minutes'
ORDER BY
  age(now(), pg_stat_activity.query_start) DESC
