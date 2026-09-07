import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyIndexStatsSpec } from "../index-stats/index-stats.query.ts";

export const legacyInspectDbUnusedIndexes = legacyMakeInspectDbHandler(
  legacyIndexStatsSpec,
  "legacy.inspect.db.unused-indexes",
  legacyInspectDeprecationNotice("unused-indexes", "index-stats"),
);
