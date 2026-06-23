import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyRoleStatsSpec } from "./role-stats.query.ts";

export const legacyInspectDbRoleStats = legacyMakeInspectDbHandler(
  legacyRoleStatsSpec,
  "legacy.inspect.db.role-stats",
);
