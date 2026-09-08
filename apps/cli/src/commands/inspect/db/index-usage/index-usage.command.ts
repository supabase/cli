import { Command } from "effect/unstable/cli";
import { inspectDbIndexUsage } from "./index-usage.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbIndexUsageCommand = Command.make("index-usage", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show information about the efficiency of indexes. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show index efficiency (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbIndexUsage)),
  Command.provide(inspectDbRuntimeLayer("index-usage")),
);
