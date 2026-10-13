import { inspectRemovalNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { tableStatsSpec } from "../table-stats/table-stats.query.ts";

export const inspectDbTableIndexSizes = makeInspectDbHandler(
  tableStatsSpec,
  "inspect.db.table-index-sizes",
  inspectRemovalNotice("table-index-sizes", "table-stats"),
);
