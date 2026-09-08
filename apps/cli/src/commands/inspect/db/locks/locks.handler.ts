import { makeInspectDbHandler } from "../inspect-query.ts";
import { locksSpec } from "./locks.query.ts";

export const inspectDbLocks = makeInspectDbHandler(locksSpec, "inspect.db.locks");
