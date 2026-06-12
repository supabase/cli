import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyTableStatsSpec } from "../table-stats/table-stats.query.ts";

export const legacyInspectDbTotalTableSizes = legacyMakeInspectDbHandler(
  legacyTableStatsSpec,
  "legacy.inspect.db.total-table-sizes",
  legacyInspectDeprecationNotice("total-table-sizes", "table-stats"),
);
