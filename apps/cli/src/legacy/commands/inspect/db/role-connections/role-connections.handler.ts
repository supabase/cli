import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyRoleStatsSpec } from "../role-stats/role-stats.query.ts";

export const legacyInspectDbRoleConnections = legacyMakeInspectDbHandler(
  legacyRoleStatsSpec,
  "legacy.inspect.db.role-connections",
  legacyInspectDeprecationNotice("role-connections", "role-stats"),
);
