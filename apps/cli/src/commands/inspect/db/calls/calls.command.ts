import { Command } from "effect/unstable/cli";
import { legacyInspectDbCalls } from "./calls.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbCallsCommand = Command.make("calls", LEGACY_INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show queries from pg_stat_statements ordered by total times called."),
  Command.withShortDescription("Show queries by call count"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbCalls)),
  Command.provide(legacyInspectDbRuntimeLayer("calls")),
);
