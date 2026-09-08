import { Command } from "effect/unstable/cli";
import { inspectDbTotalIndexSize } from "./total-index-size.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbTotalIndexSizeCommand = Command.make(
  "total-index-size",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription('Show total size of all indexes. Deprecated: use "index-stats" instead.'),
  Command.withShortDescription("Show total index size (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbTotalIndexSize)),
  Command.provide(inspectDbRuntimeLayer("total-index-size")),
);
