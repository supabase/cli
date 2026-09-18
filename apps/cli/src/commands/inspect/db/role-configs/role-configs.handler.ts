import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { roleStatsSpec } from "../role-stats/role-stats.query.ts";

export const inspectDbRoleConfigs = makeInspectDbHandler(
  roleStatsSpec,
  "inspect.db.role-configs",
  inspectDeprecationNotice("role-configs", "role-stats"),
);
