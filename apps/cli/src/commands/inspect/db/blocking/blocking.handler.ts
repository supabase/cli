import { makeInspectDbHandler } from "../inspect-query.ts";
import { blockingSpec } from "./blocking.query.ts";

export const inspectDbBlocking = makeInspectDbHandler(blockingSpec, "inspect.db.blocking");
