import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyCallsSpec } from "./calls.query.ts";

export const legacyInspectDbCalls = legacyMakeInspectDbHandler(
  legacyCallsSpec,
  "legacy.inspect.db.calls",
);
