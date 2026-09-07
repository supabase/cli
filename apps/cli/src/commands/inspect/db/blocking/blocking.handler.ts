import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyBlockingSpec } from "./blocking.query.ts";

export const legacyInspectDbBlocking = legacyMakeInspectDbHandler(
  legacyBlockingSpec,
  "legacy.inspect.db.blocking",
);
