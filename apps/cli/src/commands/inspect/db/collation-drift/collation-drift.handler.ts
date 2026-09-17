import { legacyMakeInspectDbReportHandler } from "../legacy-inspect-report.ts";
import { legacyCollationDriftSpec } from "./collation-drift.query.ts";

export const legacyInspectDbCollationDrift = legacyMakeInspectDbReportHandler(
  legacyCollationDriftSpec,
  "legacy.inspect.db.collation-drift",
);
