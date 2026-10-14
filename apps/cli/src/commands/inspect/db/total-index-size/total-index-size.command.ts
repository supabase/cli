import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbTotalIndexSize } from "./total-index-size.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbTotalIndexSizeCommand = Command.make(
  "total-index-size",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show total size of all indexes. Deprecated: use "index-stats" instead; removed in v3.',
  ),
  Command.withShortDescription("Show total index size (deprecated)"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbTotalIndexSize)),
  Command.provide(inspectDbRuntimeLayer("total-index-size")),
);
