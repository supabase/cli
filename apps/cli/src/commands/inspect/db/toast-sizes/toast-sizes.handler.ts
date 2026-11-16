import { makeInspectDbHandler } from "../inspect-query.ts";
import { toastSizesSpec } from "./toast-sizes.query.ts";

export const inspectDbToastSizes = makeInspectDbHandler(toastSizesSpec, "inspect.db.toast-sizes");
