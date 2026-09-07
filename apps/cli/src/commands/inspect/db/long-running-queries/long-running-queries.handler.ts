import { legacyMakeInspectDbHandler } from "../legacy-inspect-query.ts";
import { legacyLongRunningQueriesSpec } from "./long-running-queries.query.ts";

export const legacyInspectDbLongRunningQueries = legacyMakeInspectDbHandler(
  legacyLongRunningQueriesSpec,
  "legacy.inspect.db.long-running-queries",
);
