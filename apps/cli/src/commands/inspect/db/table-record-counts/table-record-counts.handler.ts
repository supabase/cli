import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyIndexStatsSpec } from "../index-stats/index-stats.query.ts";

export const legacyInspectDbTableRecordCounts = legacyMakeInspectDbHandler(
  legacyIndexStatsSpec,
  "legacy.inspect.db.table-record-counts",
  legacyInspectDeprecationNotice("table-record-counts", "table-stats"),
);
