import { makeInspectDbHandler } from "../inspect-query.ts";
import { trafficProfileSpec } from "./traffic-profile.query.ts";

export const inspectDbTrafficProfile = makeInspectDbHandler(
  trafficProfileSpec,
  "inspect.db.traffic-profile",
);
