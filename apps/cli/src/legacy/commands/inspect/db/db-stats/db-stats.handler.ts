import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyDbStatsSpec } from "./db-stats.query.ts";

export const legacyInspectDbDbStats = legacyMakeInspectDbHandler(
  legacyDbStatsSpec,
  "legacy.inspect.db.db-stats",
);
