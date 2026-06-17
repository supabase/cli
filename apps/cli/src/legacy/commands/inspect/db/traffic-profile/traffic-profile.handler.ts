import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyTrafficProfileSpec } from "./traffic-profile.query.ts";

export const legacyInspectDbTrafficProfile = legacyMakeInspectDbHandler(
  legacyTrafficProfileSpec,
  "legacy.inspect.db.traffic-profile",
);
