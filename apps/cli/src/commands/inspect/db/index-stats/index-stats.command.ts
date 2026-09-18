import { Command } from "effect/unstable/cli";
import { inspectDbIndexStats } from "./index-stats.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbIndexStatsCommand = Command.make("index-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Show combined index size, usage percent, scan counts, and unused status.",
  ),
  Command.withShortDescription("Show index stats"),
  Command.withHandler(inspectDbCommandHandler(inspectDbIndexStats)),
  Command.provide(inspectDbRuntimeLayer("index-stats")),
);
