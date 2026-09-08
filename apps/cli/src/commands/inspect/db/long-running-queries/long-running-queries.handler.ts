import { makeInspectDbHandler } from "../inspect-query.ts";
import { longRunningQueriesSpec } from "./long-running-queries.query.ts";

export const inspectDbLongRunningQueries = makeInspectDbHandler(
  longRunningQueriesSpec,
  "inspect.db.long-running-queries",
);
