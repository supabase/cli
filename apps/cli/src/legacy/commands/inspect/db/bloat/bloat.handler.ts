import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyBloatSpec } from "./bloat.query.ts";

export const legacyInspectDbBloat = legacyMakeInspectDbHandler(
  legacyBloatSpec,
  "legacy.inspect.db.bloat",
);
