import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbRoleConfigs } from "./role-configs.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbRoleConfigsCommand = Command.make("role-configs", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show configuration settings for database roles when they have been modified. Deprecated: use "role-stats" instead.',
  ),
  Command.withShortDescription("Show role configs (deprecated)"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbRoleConfigs)),
  Command.provide(inspectDbRuntimeLayer("role-configs")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
);
