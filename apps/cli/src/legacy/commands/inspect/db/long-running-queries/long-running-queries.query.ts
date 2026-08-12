import {
  legacyInspectInt,
  legacyInspectText,
  type LegacyInspectQuerySpec,
} from "../legacy-inspect-query.ts";

// Verbatim from `apps/cli-go/internal/inspect/long_running_queries/long_running_queries.sql` (deleted in CLI-1970; last present at commit 7b469f5b3).
const SQL = `SELECT
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
  age(now(), pg_stat_activity.query_start) DESC`;

/**
 * `inspect db long-running-queries` — queries running longer than 5 minutes.
 * Port of `apps/cli-go/internal/inspect/long_running_queries/long_running_queries.go`
 * (deleted in CLI-1970; last present at commit 7b469f5b3).
 * Note: unlike locks/blocking/outliers/calls, the `query` column is NOT
 * whitespace-collapsed in Go (`%s` directly), so it uses `legacyInspectText`.
 */
export const legacyLongRunningQueriesSpec: LegacyInspectQuerySpec = {
  name: "long-running-queries",
  sql: SQL,
  params: () => [],
  headers: ["pid", "Duration", "Query"],
  project: (row) => [
    legacyInspectInt(row["pid"]),
    legacyInspectText(row["duration"]),
    legacyInspectText(row["query"]),
  ],
};
