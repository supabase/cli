import {
  legacyInspectInt,
  legacyInspectText,
  type LegacyInspectQuerySpec,
} from "../legacy-inspect-query.ts";

// Verbatim from `apps/cli-go/internal/inspect/role_stats/role_stats.sql` (deleted in CLI-1970; last present at commit 7b469f5b3).
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
 * Port of `apps/cli-go/internal/inspect/role_stats/role_stats.go` (deleted in
 * CLI-1970; last present at commit 7b469f5b3). Also the
 * routed query for the deprecated `role-configs` / `role-connections` aliases.
 */
export const legacyRoleStatsSpec: LegacyInspectQuerySpec = {
  name: "role-stats",
  sql: SQL,
  params: () => [],
  headers: ["Role name", "Active connections", "Connection limit", "Custom config"],
  project: (row) => [
    legacyInspectText(row["role_name"]),
    legacyInspectInt(row["active_connections"]),
    legacyInspectInt(row["connection_limit"]),
    legacyInspectText(row["custom_config"]),
  ],
};
