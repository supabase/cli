import { bloatSpec } from "../db/bloat/bloat.query.ts";
import { blockingSpec } from "../db/blocking/blocking.query.ts";
import { callsSpec } from "../db/calls/calls.query.ts";
import { dbStatsSpec } from "../db/db-stats/db-stats.query.ts";
import { indexStatsSpec } from "../db/index-stats/index-stats.query.ts";
import { INTERNAL_SCHEMAS, likeEscapeSchema } from "../db/inspect-schemas.ts";
import { locksSpec } from "../db/locks/locks.query.ts";
import { longRunningQueriesSpec } from "../db/long-running-queries/long-running-queries.query.ts";
import { outliersSpec } from "../db/outliers/outliers.query.ts";
import { replicationSlotsSpec } from "../db/replication-slots/replication-slots.query.ts";
import { roleStatsSpec } from "../db/role-stats/role-stats.query.ts";
import { tableStatsSpec } from "../db/table-stats/table-stats.query.ts";
import { trafficProfileSpec } from "../db/traffic-profile/traffic-profile.query.ts";
import { vacuumStatsSpec } from "../db/vacuum-stats/vacuum-stats.query.ts";

/**
 * The `unused_indexes` query. `inspect db` folds `unused-indexes` into a deprecated alias of
 * `index-stats`, so there's no existing `InspectQuerySpec` for it; the report defines its own.
 */
const UNUSED_INDEXES_REPORT_SQL = `SELECT
  FORMAT('%I.%I', schemaname, relname) AS name,
  indexrelname AS index,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size,
  idx_scan as index_scans
FROM pg_stat_user_indexes ui
JOIN pg_index i ON ui.indexrelid = i.indexrelid
WHERE
  NOT indisunique AND idx_scan < 50 AND pg_relation_size(relid) > 5 * 8192
  AND NOT schemaname LIKE ANY($1)
ORDER BY
  pg_relation_size(i.indexrelid) / nullif(idx_scan, 0) DESC NULLS FIRST,
  pg_relation_size(i.indexrelid) DESC`;

/**
 * One report query: the CSV basename (SQL filename with underscores, e.g. `db_stats` — not the
 * `inspect db` spec name `db-stats`) and the SQL to run.
 *
 * `COPY` can't bind parameters, so placeholders are substituted textually by `wrapReportQuery`
 * instead of `spec.params()`.
 */
export interface ReportQuery {
  readonly fileName: string;
  readonly sql: string;
}

/**
 * The 14 report queries. Reuses the 13 `inspect db` specs' `.sql` verbatim
 * (byte-identical COPY input → byte-identical CSVs) plus the standalone
 * `unused_indexes` query.
 */
export const REPORT_QUERIES: ReadonlyArray<ReportQuery> = [
  { fileName: "bloat", sql: bloatSpec.sql },
  { fileName: "blocking", sql: blockingSpec.sql },
  { fileName: "calls", sql: callsSpec.sql },
  { fileName: "db_stats", sql: dbStatsSpec.sql },
  { fileName: "index_stats", sql: indexStatsSpec.sql },
  { fileName: "locks", sql: locksSpec.sql },
  { fileName: "long_running_queries", sql: longRunningQueriesSpec.sql },
  { fileName: "outliers", sql: outliersSpec.sql },
  { fileName: "replication_slots", sql: replicationSlotsSpec.sql },
  { fileName: "role_stats", sql: roleStatsSpec.sql },
  { fileName: "table_stats", sql: tableStatsSpec.sql },
  { fileName: "traffic_profile", sql: trafficProfileSpec.sql },
  { fileName: "unused_indexes", sql: UNUSED_INDEXES_REPORT_SQL },
  { fileName: "vacuum_stats", sql: vacuumStatsSpec.sql },
];

/**
 * The `$1` substitution value: the internal schemas escaped into `LIKE` patterns
 * and rendered as a Postgres `text[]` literal.
 */
export function reportIgnoreSchemas(): string {
  return `'{${likeEscapeSchema(INTERNAL_SCHEMAS).join(",")}}'::text[]`;
}

/**
 * Substitutes each `$1`, `$2`, … placeholder with the corresponding `arg` (every occurrence,
 * since a placeholder can repeat), then wraps the result in `COPY (...) TO STDOUT WITH CSV HEADER`.
 */
export function wrapReportQuery(sql: string, ...args: ReadonlyArray<string>): string {
  let query = sql;
  for (let index = 0; index < args.length; index++) {
    query = query.replaceAll(`$${index + 1}`, args[index]!);
  }
  return `COPY (${query}) TO STDOUT WITH CSV HEADER`;
}
