import { makeInspectDbHandler } from "../inspect-query.ts";
import { outliersSpec } from "./outliers.query.ts";

export const inspectDbOutliers = makeInspectDbHandler(outliersSpec, "inspect.db.outliers");
