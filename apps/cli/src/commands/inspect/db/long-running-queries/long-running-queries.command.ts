import { Command } from "effect/unstable/cli";
import { legacyInspectDbLongRunningQueries } from "./long-running-queries.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbLongRunningQueriesCommand = Command.make(
  "long-running-queries",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Show currently running queries running for longer than 5 minutes."),
  Command.withShortDescription("Show long-running queries"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbLongRunningQueries)),
  Command.provide(legacyInspectDbRuntimeLayer("long-running-queries")),
);
