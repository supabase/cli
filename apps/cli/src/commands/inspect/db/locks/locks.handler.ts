import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyLocksSpec } from "./locks.query.ts";

export const legacyInspectDbLocks = legacyMakeInspectDbHandler(
  legacyLocksSpec,
  "legacy.inspect.db.locks",
);
