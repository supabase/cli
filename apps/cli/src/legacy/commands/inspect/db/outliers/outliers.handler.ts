import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyOutliersSpec } from "./outliers.query.ts";

export const legacyInspectDbOutliers = legacyMakeInspectDbHandler(
  legacyOutliersSpec,
  "legacy.inspect.db.outliers",
);
