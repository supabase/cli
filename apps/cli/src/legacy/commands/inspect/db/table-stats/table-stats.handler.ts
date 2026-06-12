import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyTableStatsSpec } from "./table-stats.query.ts";

export const legacyInspectDbTableStats = legacyMakeInspectDbHandler(
  legacyTableStatsSpec,
  "legacy.inspect.db.table-stats",
);
