import { Command } from "effect/unstable/cli";
import { inspectDbDbStats } from "./db-stats.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbDbStatsCommand = Command.make("db-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show stats such as cache hit rates, total sizes, and WAL size."),
  Command.withShortDescription("Show database stats"),
  Command.withHandler(inspectDbCommandHandler(inspectDbDbStats)),
  Command.provide(inspectDbRuntimeLayer("db-stats")),
);
