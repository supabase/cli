import { Command } from "effect/unstable/cli";
import { inspectDbUnusedIndexes } from "./unused-indexes.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbUnusedIndexesCommand = Command.make("unused-indexes", INSPECT_DB_FLAGS).pipe(
  Command.withDescription('Show indexes with low usage. Deprecated: use "index-stats" instead.'),
  Command.withShortDescription("Show unused indexes (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbUnusedIndexes)),
  Command.provide(inspectDbRuntimeLayer("unused-indexes")),
);
