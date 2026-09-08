import { Command } from "effect/unstable/cli";
import { inspectDbTableIndexSizes } from "./table-index-sizes.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbTableIndexSizesCommand = Command.make(
  "table-index-sizes",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show index sizes of individual tables. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table index sizes (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbTableIndexSizes)),
  Command.provide(inspectDbRuntimeLayer("table-index-sizes")),
);
