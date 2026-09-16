import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { tableStatsSpec } from "../table-stats/table-stats.query.ts";

export const inspectDbTableIndexSizes = makeInspectDbHandler(
  tableStatsSpec,
  "inspect.db.table-index-sizes",
  inspectDeprecationNotice("table-index-sizes", "table-stats"),
);
