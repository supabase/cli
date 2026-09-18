import {
  inspectBacktickStmt,
  inspectInt,
  inspectStmt,
  inspectText,
  type InspectQuerySpec,
} from "../inspect-query.ts";

const SQL = `SELECT
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
WHERE NOT bl.granted`;

/**
 * `inspect db blocking` — queries holding locks and the queries waiting on them. Both statement
 * columns are whitespace-collapsed; only `blocking_statement` (col 2) is backtick-wrapped —
 * `blocked_statement` (col 5) stays bare.
 */
export const blockingSpec: InspectQuerySpec = {
  name: "blocking",
  sql: SQL,
  params: () => [],
  headers: [
    "blocked pid",
    "blocking statement",
    "blocking duration",
    "blocking pid",
    "blocked statement",
    "blocked duration",
  ],
  project: (row) => [
    inspectInt(row["blocked_pid"]),
    inspectBacktickStmt(row["blocking_statement"]),
    inspectText(row["blocking_duration"]),
    inspectInt(row["blocking_pid"]),
    inspectStmt(row["blocked_statement"]),
    inspectText(row["blocked_duration"]),
  ],
};
