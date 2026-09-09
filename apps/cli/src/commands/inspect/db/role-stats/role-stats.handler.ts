import { makeInspectDbHandler } from "../inspect-query.ts";
import { roleStatsSpec } from "./role-stats.query.ts";

export const inspectDbRoleStats = makeInspectDbHandler(roleStatsSpec, "inspect.db.role-stats");
