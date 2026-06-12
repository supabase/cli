import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyVacuumStatsSpec } from "./vacuum-stats.query.ts";

export const legacyInspectDbVacuumStats = legacyMakeInspectDbHandler(
  legacyVacuumStatsSpec,
  "legacy.inspect.db.vacuum-stats",
);
