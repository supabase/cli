import {
  legacyInspectBacktickStmt,
  legacyInspectInt,
  legacyInspectStmt,
  legacyInspectText,
  type LegacyInspectQuerySpec,
} from "../legacy-inspect-query.ts";

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
 * `inspect db blocking` — queries holding locks and the queries waiting on them.
 * Both statement columns are whitespace-collapsed; the row format
 * backtick-wraps every column EXCEPT `blocked_statement` (col 5), so
 * `blocking_statement` (col 2) uses the backtick variant and col 5 stays bare.
 */
export const legacyBlockingSpec: LegacyInspectQuerySpec = {
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
    legacyInspectInt(row["blocked_pid"]),
    legacyInspectBacktickStmt(row["blocking_statement"]),
    legacyInspectText(row["blocking_duration"]),
    legacyInspectInt(row["blocking_pid"]),
    legacyInspectStmt(row["blocked_statement"]),
    legacyInspectText(row["blocked_duration"]),
  ],
};
