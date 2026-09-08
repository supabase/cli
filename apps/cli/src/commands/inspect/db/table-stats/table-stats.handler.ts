import { makeInspectDbHandler } from "../inspect-query.ts";
import { tableStatsSpec } from "./table-stats.query.ts";

export const inspectDbTableStats = makeInspectDbHandler(tableStatsSpec, "inspect.db.table-stats");
