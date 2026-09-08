import { Command } from "effect/unstable/cli";
import { inspectDbCalls } from "./calls.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbCallsCommand = Command.make("calls", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show queries from pg_stat_statements ordered by total times called."),
  Command.withShortDescription("Show queries by call count"),
  Command.withHandler(inspectDbCommandHandler(inspectDbCalls)),
  Command.provide(inspectDbRuntimeLayer("calls")),
);
