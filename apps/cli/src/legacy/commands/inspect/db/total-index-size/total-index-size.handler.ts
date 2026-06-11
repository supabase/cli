import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyIndexStatsSpec } from "../index-stats/index-stats.query.ts";

export const legacyInspectDbTotalIndexSize = legacyMakeInspectDbHandler(
  legacyIndexStatsSpec,
  "legacy.inspect.db.total-index-size",
  legacyInspectDeprecationNotice("total-index-size", "index-stats"),
);
