import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { indexStatsSpec } from "../index-stats/index-stats.query.ts";

export const inspectDbTotalIndexSize = makeInspectDbHandler(
  indexStatsSpec,
  "inspect.db.total-index-size",
  inspectDeprecationNotice("total-index-size", "index-stats"),
);
