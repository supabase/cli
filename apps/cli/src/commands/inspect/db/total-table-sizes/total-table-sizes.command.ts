import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbTotalTableSizes } from "./total-table-sizes.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbTotalTableSizesCommand = Command.make(
  "total-table-sizes",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show total table sizes, including table index sizes. Deprecated: use "table-stats" instead; removed in v3.',
  ),
  Command.withShortDescription("Show total table sizes (deprecated)"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbTotalTableSizes)),
  Command.provide(inspectDbRuntimeLayer("total-table-sizes")),
);
