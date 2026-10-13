import { inspectRemovalNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { tableStatsSpec } from "../table-stats/table-stats.query.ts";

export const inspectDbTotalTableSizes = makeInspectDbHandler(
  tableStatsSpec,
  "inspect.db.total-table-sizes",
  inspectRemovalNotice("total-table-sizes", "table-stats"),
);
