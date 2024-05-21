SELECT
  rolname,
  (
    SELECT
      count(*)
    FROM
      pg_stat_activity
    WHERE
      pg_roles.rolname = pg_stat_activity.usename
  ) AS active_connections,
  CASE WHEN rolconnlimit = -1
    THEN current_setting('max_connections')::int8
    ELSE rolconnlimit
  END AS connection_limit
FROM pg_roles
ORDER BY 2 DESC
