import { Command } from "effect/unstable/cli";
import { inspectDbTotalTableSizes } from "./total-table-sizes.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbTotalTableSizesCommand = Command.make(
  "total-table-sizes",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show total table sizes, including table index sizes. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show total table sizes (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbTotalTableSizes)),
  Command.provide(inspectDbRuntimeLayer("total-table-sizes")),
);
