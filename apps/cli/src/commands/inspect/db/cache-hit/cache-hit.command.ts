import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbCacheHit } from "./cache-hit.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbCacheHitCommand = Command.make("cache-hit", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show cache hit rates for tables and indices. Deprecated: use "db-stats" instead.',
  ),
  Command.withShortDescription("Show cache hit rates (deprecated)"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbCacheHit)),
  Command.provide(inspectDbRuntimeLayer("cache-hit")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
);
