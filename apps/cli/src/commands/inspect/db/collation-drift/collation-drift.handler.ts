import { makeInspectDbReportHandler } from "../inspect-report.ts";
import { collationDriftSpec } from "./collation-drift.query.ts";

export const inspectDbCollationDrift = makeInspectDbReportHandler(
  collationDriftSpec,
  "inspect.db.collation-drift",
);
