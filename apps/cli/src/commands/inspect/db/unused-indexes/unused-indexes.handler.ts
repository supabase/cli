import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { indexStatsSpec } from "../index-stats/index-stats.query.ts";

export const inspectDbUnusedIndexes = makeInspectDbHandler(
  indexStatsSpec,
  "inspect.db.unused-indexes",
  inspectDeprecationNotice("unused-indexes", "index-stats"),
);
