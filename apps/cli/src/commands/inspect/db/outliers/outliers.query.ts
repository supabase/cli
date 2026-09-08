import { inspectBacktickStmt, inspectText, type InspectQuerySpec } from "../inspect-query.ts";

const SQL = `SELECT
  (interval '1 millisecond' * total_exec_time)::text AS total_exec_time,
  to_char((total_exec_time/sum(total_exec_time) OVER()) * 100, 'FM90D0') || '%'  AS prop_exec_time,
  to_char(calls, 'FM999G999G999G990') AS ncalls,
  /*
    Handle column names for 15 and 17
  */
  (
    interval '1 millisecond' * (
      COALESCE(
        (to_jsonb(s) ->> 'shared_blk_read_time')::double precision,
        (to_jsonb(s) ->> 'blk_read_time')::double precision,
        0
      )
      +
      COALESCE(
        (to_jsonb(s) ->> 'shared_blk_write_time')::double precision,
        (to_jsonb(s) ->> 'blk_write_time')::double precision,
        0
      )
    )
  )::text AS sync_io_time,
  query
FROM extensions.pg_stat_statements s WHERE userid = (SELECT usesysid FROM pg_user WHERE usename = current_user LIMIT 1)
ORDER BY total_exec_time DESC
LIMIT 10`;

/**
 * `inspect db outliers` — pg_stat_statements ordered by total execution time.
 * The `query` column is whitespace-collapsed and rendered first.
 */
export const outliersSpec: InspectQuerySpec = {
  name: "outliers",
  sql: SQL,
  params: () => [],
  headers: ["Query", "Execution Time", "Proportion of exec time", "Number Calls", "Sync IO time"],
  project: (row) => [
    inspectBacktickStmt(row["query"]),
    inspectText(row["total_exec_time"]),
    inspectText(row["prop_exec_time"]),
    inspectText(row["ncalls"]),
    inspectText(row["sync_io_time"]),
  ],
};
