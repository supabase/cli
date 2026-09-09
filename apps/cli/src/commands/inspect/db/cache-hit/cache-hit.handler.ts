import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { dbStatsSpec } from "../db-stats/db-stats.query.ts";

export const inspectDbCacheHit = makeInspectDbHandler(
  dbStatsSpec,
  "inspect.db.cache-hit",
  inspectDeprecationNotice("cache-hit", "db-stats"),
);
