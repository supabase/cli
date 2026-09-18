import { Command } from "effect/unstable/cli";
import { inspectDbIndexSizes } from "./index-sizes.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbIndexSizesCommand = Command.make("index-sizes", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show index sizes of individual indexes. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show individual index sizes (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbIndexSizes)),
  Command.provide(inspectDbRuntimeLayer("index-sizes")),
);
