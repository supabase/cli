import { inspectRemovalNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { indexStatsSpec } from "../index-stats/index-stats.query.ts";

export const inspectDbTotalIndexSize = makeInspectDbHandler(
  indexStatsSpec,
  "inspect.db.total-index-size",
  inspectRemovalNotice("total-index-size", "index-stats"),
);
