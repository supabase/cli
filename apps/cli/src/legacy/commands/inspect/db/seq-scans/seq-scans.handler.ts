import {
  legacyInspectDeprecationNotice,
  legacyMakeInspectDbHandler,
} from "../legacy-inspect-query.ts";
import { legacyIndexStatsSpec } from "../index-stats/index-stats.query.ts";

export const legacyInspectDbSeqScans = legacyMakeInspectDbHandler(
  legacyIndexStatsSpec,
  "legacy.inspect.db.seq-scans",
  legacyInspectDeprecationNotice("seq-scans", "index-stats"),
);
