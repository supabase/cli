import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { indexStatsSpec } from "../index-stats/index-stats.query.ts";

export const inspectDbIndexSizes = makeInspectDbHandler(
  indexStatsSpec,
  "inspect.db.index-sizes",
  inspectDeprecationNotice("index-sizes", "index-stats"),
);
