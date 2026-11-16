import { makeInspectDbHandler } from "../inspect-query.ts";
import { xidAgeSpec } from "./xid-age.query.ts";

export const inspectDbXidAge = makeInspectDbHandler(xidAgeSpec, "inspect.db.xid-age");
