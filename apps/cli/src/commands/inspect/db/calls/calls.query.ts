import { inspectBacktickStmt, inspectText, type InspectQuerySpec } from "../inspect-query.ts";

const SQL = `SELECT
  query,
  (interval '1 millisecond' * total_exec_time)::text AS total_exec_time,
  to_char((total_exec_time/sum(total_exec_time) OVER()) * 100, 'FM90D0') || '%'  AS prop_exec_time,
  to_char(calls, 'FM999G999G999G999G990') AS ncalls,
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
  )::text AS sync_io_time
FROM extensions.pg_stat_statements s
ORDER BY calls DESC
LIMIT 10`;

/**
 * `inspect db calls` — pg_stat_statements ordered by number of calls.
 * The `query` column is whitespace-collapsed and rendered first.
 */
export const callsSpec: InspectQuerySpec = {
  name: "calls",
  sql: SQL,
  params: () => [],
  headers: [
    "Query",
    "Total Execution Time",
    "Proportion of total exec time",
    "Number Calls",
    "Sync IO time",
  ],
  project: (row) => [
    inspectBacktickStmt(row["query"]),
    inspectText(row["total_exec_time"]),
    inspectText(row["prop_exec_time"]),
    inspectText(row["ncalls"]),
    inspectText(row["sync_io_time"]),
  ],
};
