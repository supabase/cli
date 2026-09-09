import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { indexStatsSpec } from "../index-stats/index-stats.query.ts";

export const inspectDbIndexUsage = makeInspectDbHandler(
  indexStatsSpec,
  "inspect.db.index-usage",
  inspectDeprecationNotice("index-usage", "index-stats"),
);
