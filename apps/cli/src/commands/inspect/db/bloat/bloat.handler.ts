import { makeInspectDbHandler } from "../inspect-query.ts";
import { bloatSpec } from "./bloat.query.ts";

export const inspectDbBloat = makeInspectDbHandler(bloatSpec, "inspect.db.bloat");
