import { inspectInt, inspectText, type InspectQuerySpec } from "../inspect-query.ts";

const SQL = `SELECT
  rolname as role_name,
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
  END AS connection_limit,
  array_to_string(rolconfig, ',', '*') as custom_config
FROM
  pg_roles
ORDER BY 1 DESC`;

/**
 * `inspect db role-stats` — roles, connection counts/limits, and custom config.
 * Also the routed query for the deprecated `role-configs` / `role-connections` aliases.
 */
export const roleStatsSpec: InspectQuerySpec = {
  name: "role-stats",
  sql: SQL,
  params: () => [],
  headers: ["Role name", "Active connections", "Connection limit", "Custom config"],
  project: (row) => [
    inspectText(row["role_name"]),
    inspectInt(row["active_connections"]),
    inspectInt(row["connection_limit"]),
    inspectText(row["custom_config"]),
  ],
};
