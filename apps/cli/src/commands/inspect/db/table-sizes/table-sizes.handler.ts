import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { tableStatsSpec } from "../table-stats/table-stats.query.ts";

export const inspectDbTableSizes = makeInspectDbHandler(
  tableStatsSpec,
  "inspect.db.table-sizes",
  inspectDeprecationNotice("table-sizes", "table-stats"),
);
