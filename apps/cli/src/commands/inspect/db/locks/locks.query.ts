import {
  legacyInspectBool,
  legacyInspectInt,
  legacyInspectStmt,
  legacyInspectText,
  type LegacyInspectQuerySpec,
} from "../legacy-inspect-query.ts";

const SQL = `SELECT
  pg_stat_activity.pid,
  COALESCE(pg_class.relname, 'null') AS relname,
  COALESCE(pg_locks.transactionid::text, 'null') AS transactionid,
  pg_locks.granted,
  pg_stat_activity.query AS stmt,
  age(now(), pg_stat_activity.query_start)::text AS age
FROM pg_stat_activity, pg_locks LEFT OUTER JOIN pg_class ON (pg_locks.relation = pg_class.oid)
WHERE pg_stat_activity.query <> '<insufficient privilege>'
AND pg_locks.pid = pg_stat_activity.pid
AND pg_locks.mode = 'ExclusiveLock'
ORDER BY query_start`;

/**
 * `inspect db locks` — queries holding an exclusive lock on a relation.
 * The `stmt` column is whitespace-collapsed; the rest render as-is.
 */
export const legacyLocksSpec: LegacyInspectQuerySpec = {
  name: "locks",
  sql: SQL,
  params: () => [],
  headers: ["pid", "relname", "transaction id", "granted", "stmt", "age"],
  project: (row) => [
    legacyInspectInt(row["pid"]),
    legacyInspectText(row["relname"]),
    legacyInspectText(row["transactionid"]),
    legacyInspectBool(row["granted"]),
    legacyInspectStmt(row["stmt"]),
    legacyInspectText(row["age"]),
  ],
};
