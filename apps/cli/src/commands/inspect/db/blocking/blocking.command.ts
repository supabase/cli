import { Command } from "effect/unstable/cli";
import { inspectDbBlocking } from "./blocking.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbBlockingCommand = Command.make("blocking", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Show queries that are holding locks and the queries that are waiting for them to be released.",
  ),
  Command.withShortDescription("Show blocking queries"),
  Command.withHandler(inspectDbCommandHandler(inspectDbBlocking)),
  Command.provide(inspectDbRuntimeLayer("blocking")),
);
