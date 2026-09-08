import { Command } from "effect/unstable/cli";
import { inspectDbTableSizes } from "./table-sizes.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbTableSizesCommand = Command.make("table-sizes", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show table sizes of individual tables without their index sizes. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table sizes (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbTableSizes)),
  Command.provide(inspectDbRuntimeLayer("table-sizes")),
);
