import { makeInspectDbHandler } from "../inspect-query.ts";
import { dbStatsSpec } from "./db-stats.query.ts";

export const inspectDbDbStats = makeInspectDbHandler(dbStatsSpec, "inspect.db.db-stats");
