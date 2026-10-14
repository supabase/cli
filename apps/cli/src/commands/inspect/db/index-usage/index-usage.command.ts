import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbIndexUsage } from "./index-usage.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbIndexUsageCommand = Command.make("index-usage", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show information about the efficiency of indexes. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show index efficiency (deprecated)"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbIndexUsage)),
  Command.provide(inspectDbRuntimeLayer("index-usage")),
);
