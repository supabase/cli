import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyRoleStatsSpec } from "../role-stats/role-stats.query.ts";

export const legacyInspectDbRoleConfigs = legacyMakeInspectDbHandler(
  legacyRoleStatsSpec,
  "legacy.inspect.db.role-configs",
  legacyInspectDeprecationNotice("role-configs", "role-stats"),
);
