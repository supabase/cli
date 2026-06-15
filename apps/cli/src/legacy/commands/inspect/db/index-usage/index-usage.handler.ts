import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyIndexStatsSpec } from "../index-stats/index-stats.query.ts";

export const legacyInspectDbIndexUsage = legacyMakeInspectDbHandler(
  legacyIndexStatsSpec,
  "legacy.inspect.db.index-usage",
  legacyInspectDeprecationNotice("index-usage", "index-stats"),
);
