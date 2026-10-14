import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbTableIndexSizes } from "./table-index-sizes.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbTableIndexSizesCommand = Command.make(
  "table-index-sizes",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show index sizes of individual tables. Deprecated: use "table-stats" instead; removed in v3.',
  ),
  Command.withShortDescription("Show table index sizes (deprecated)"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbTableIndexSizes)),
  Command.provide(inspectDbRuntimeLayer("table-index-sizes")),
);
