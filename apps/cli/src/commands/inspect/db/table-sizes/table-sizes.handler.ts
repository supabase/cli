import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyTableStatsSpec } from "../table-stats/table-stats.query.ts";

export const legacyInspectDbTableSizes = legacyMakeInspectDbHandler(
  legacyTableStatsSpec,
  "legacy.inspect.db.table-sizes",
  legacyInspectDeprecationNotice("table-sizes", "table-stats"),
);
