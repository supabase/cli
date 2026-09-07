import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyIndexStatsSpec } from "../index-stats/index-stats.query.ts";

export const legacyInspectDbIndexSizes = legacyMakeInspectDbHandler(
  legacyIndexStatsSpec,
  "legacy.inspect.db.index-sizes",
  legacyInspectDeprecationNotice("index-sizes", "index-stats"),
);
