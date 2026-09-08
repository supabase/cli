import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { indexStatsSpec } from "../index-stats/index-stats.query.ts";

export const inspectDbTableRecordCounts = makeInspectDbHandler(
  indexStatsSpec,
  "inspect.db.table-record-counts",
  inspectDeprecationNotice("table-record-counts", "table-stats"),
);
