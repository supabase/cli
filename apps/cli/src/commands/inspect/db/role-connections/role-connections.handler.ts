import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { roleStatsSpec } from "../role-stats/role-stats.query.ts";

export const inspectDbRoleConnections = makeInspectDbHandler(
  roleStatsSpec,
  "inspect.db.role-connections",
  inspectDeprecationNotice("role-connections", "role-stats"),
);
