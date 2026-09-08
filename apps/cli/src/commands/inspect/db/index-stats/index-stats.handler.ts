import { makeInspectDbHandler } from "../inspect-query.ts";
import { indexStatsSpec } from "./index-stats.query.ts";

export const inspectDbIndexStats = makeInspectDbHandler(indexStatsSpec, "inspect.db.index-stats");
