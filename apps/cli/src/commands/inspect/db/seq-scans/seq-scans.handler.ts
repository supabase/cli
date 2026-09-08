import { inspectDeprecationNotice, makeInspectDbHandler } from "../inspect-query.ts";
import { indexStatsSpec } from "../index-stats/index-stats.query.ts";

export const inspectDbSeqScans = makeInspectDbHandler(
  indexStatsSpec,
  "inspect.db.seq-scans",
  inspectDeprecationNotice("seq-scans", "index-stats"),
);
