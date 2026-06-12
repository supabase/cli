import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyDbStatsSpec } from "../db-stats/db-stats.query.ts";

export const legacyInspectDbCacheHit = legacyMakeInspectDbHandler(
  legacyDbStatsSpec,
  "legacy.inspect.db.cache-hit",
  legacyInspectDeprecationNotice("cache-hit", "db-stats"),
);
