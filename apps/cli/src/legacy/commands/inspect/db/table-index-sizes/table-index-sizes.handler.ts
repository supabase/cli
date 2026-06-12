import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyTableStatsSpec } from "../table-stats/table-stats.query.ts";

export const legacyInspectDbTableIndexSizes = legacyMakeInspectDbHandler(
  legacyTableStatsSpec,
  "legacy.inspect.db.table-index-sizes",
  legacyInspectDeprecationNotice("table-index-sizes", "table-stats"),
);
