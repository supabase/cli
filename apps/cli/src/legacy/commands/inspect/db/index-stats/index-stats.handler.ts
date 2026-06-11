import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyIndexStatsSpec } from "./index-stats.query.ts";

export const legacyInspectDbIndexStats = legacyMakeInspectDbHandler(
  legacyIndexStatsSpec,
  "legacy.inspect.db.index-stats",
);
