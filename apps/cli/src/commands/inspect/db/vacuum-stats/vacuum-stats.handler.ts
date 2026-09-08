import { makeInspectDbHandler } from "../inspect-query.ts";
import { vacuumStatsSpec } from "./vacuum-stats.query.ts";

export const inspectDbVacuumStats = makeInspectDbHandler(
  vacuumStatsSpec,
  "inspect.db.vacuum-stats",
);
