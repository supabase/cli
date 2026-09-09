import { Command } from "effect/unstable/cli";
import { inspectDbTableStats } from "./table-stats.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbTableStatsCommand = Command.make("table-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show combined table size, index size, and estimated row count."),
  Command.withShortDescription("Show table stats"),
  Command.withHandler(inspectDbCommandHandler(inspectDbTableStats)),
  Command.provide(inspectDbRuntimeLayer("table-stats")),
);
