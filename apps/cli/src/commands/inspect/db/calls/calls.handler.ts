import { makeInspectDbHandler } from "../inspect-query.ts";
import { callsSpec } from "./calls.query.ts";

export const inspectDbCalls = makeInspectDbHandler(callsSpec, "inspect.db.calls");
