import { legacyBloatSpec } from "../db/bloat/bloat.query.ts";
import { legacyBlockingSpec } from "../db/blocking/blocking.query.ts";
import { legacyCallsSpec } from "../db/calls/calls.query.ts";
import { legacyDbStatsSpec } from "../db/db-stats/db-stats.query.ts";
import { legacyIndexStatsSpec } from "../db/index-stats/index-stats.query.ts";
import { LEGACY_INTERNAL_SCHEMAS, legacyLikeEscapeSchema } from "../db/legacy-inspect-schemas.ts";
import { legacyLocksSpec } from "../db/locks/locks.query.ts";
import { legacyLongRunningQueriesSpec } from "../db/long-running-queries/long-running-queries.query.ts";
import { legacyOutliersSpec } from "../db/outliers/outliers.query.ts";
import { legacyReplicationSlotsSpec } from "../db/replication-slots/replication-slots.query.ts";
import { legacyRoleStatsSpec } from "../db/role-stats/role-stats.query.ts";
import { legacyTableStatsSpec } from "../db/table-stats/table-stats.query.ts";
import { legacyTrafficProfileSpec } from "../db/traffic-profile/traffic-profile.query.ts";
import { legacyVacuumStatsSpec } from "../db/vacuum-stats/vacuum-stats.query.ts";

/**
 * The `unused_indexes` query, verbatim from
 * `apps/cli-go/internal/inspect/unused_indexes/unused_indexes.sql`. The `inspect db`
 * tree folds `unused-indexes` into a deprecated alias of `index-stats`, so this
 * distinct query (columns: `name`, `index`, `index_size`, `index_scans`) has no
 * existing `LegacyInspectQuerySpec`; the report still emits its own `unused_indexes.csv`
 * (report.go embeds every nested `.sql`, so it walks all 14 files).
 */
const LEGACY_UNUSED_INDEXES_REPORT_SQL = `SELECT
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
 * One report query: the basename Go derives from the embedded SQL filename
 * (`strings.Split(d.Name(), ".")[0]`, `report.go:52`) and the SQL it runs.
 *
 * The `fileName` is the **SQL basename with underscores** (`db_stats`), which is
 * also the CSV name (`<fileName>.csv`) — NOT the `inspect db` spec `name`
 * (`db-stats`). The report does not bind parameters: `COPY` cannot, so the
 * placeholders are substituted textually by `legacyWrapReportQuery`, not via
 * `spec.params()`.
 */
export interface LegacyReportQuery {
  readonly fileName: string;
  readonly sql: string;
}

/**
 * The 14 report queries, 1:1 with the SQL files Go embeds under
 * `internal/inspect`. Reuses the 13 `inspect db` specs' `.sql` verbatim
 * (byte-identical COPY input → byte-identical CSVs) plus the standalone
 * `unused_indexes` query.
 */
export const LEGACY_REPORT_QUERIES: ReadonlyArray<LegacyReportQuery> = [
  { fileName: "bloat", sql: legacyBloatSpec.sql },
  { fileName: "blocking", sql: legacyBlockingSpec.sql },
  { fileName: "calls", sql: legacyCallsSpec.sql },
  { fileName: "db_stats", sql: legacyDbStatsSpec.sql },
  { fileName: "index_stats", sql: legacyIndexStatsSpec.sql },
  { fileName: "locks", sql: legacyLocksSpec.sql },
  { fileName: "long_running_queries", sql: legacyLongRunningQueriesSpec.sql },
  { fileName: "outliers", sql: legacyOutliersSpec.sql },
  { fileName: "replication_slots", sql: legacyReplicationSlotsSpec.sql },
  { fileName: "role_stats", sql: legacyRoleStatsSpec.sql },
  { fileName: "table_stats", sql: legacyTableStatsSpec.sql },
  { fileName: "traffic_profile", sql: legacyTrafficProfileSpec.sql },
  { fileName: "unused_indexes", sql: LEGACY_UNUSED_INDEXES_REPORT_SQL },
  { fileName: "vacuum_stats", sql: legacyVacuumStatsSpec.sql },
];

/**
 * The `$1` substitution value: the internal schemas escaped into `LIKE` patterns
 * and rendered as a Postgres `text[]` literal. 1:1 with Go's package-level
 * `ignoreSchemas` (`report.go:62`):
 * `fmt.Sprintf("'{%s}'::text[]", strings.Join(reset.LikeEscapeSchema(utils.InternalSchemas), ","))`.
 */
export function legacyReportIgnoreSchemas(): string {
  return `'{${legacyLikeEscapeSchema(LEGACY_INTERNAL_SCHEMAS).join(",")}}'::text[]`;
}

/**
 * Port of Go's `wrapQuery` (`report.go:79-84`): substitute each positional
 * placeholder (`$1`, `$2`, …) with the corresponding `arg` via `ReplaceAll`
 * (every occurrence — `$1` appears 3× in `index_stats.sql`), in order, then wrap
 * the result in `COPY (...) TO STDOUT WITH CSV HEADER`. With no args it is a pure
 * wrap.
 */
export function legacyWrapReportQuery(sql: string, ...args: ReadonlyArray<string>): string {
  let query = sql;
  for (let index = 0; index < args.length; index++) {
    query = query.replaceAll(`$${index + 1}`, args[index]!);
  }
  return `COPY (${query}) TO STDOUT WITH CSV HEADER`;
}
