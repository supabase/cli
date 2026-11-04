import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbRoleConfigs } from "./role-configs.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
  withInspectDbTargetPolicy,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";
import { makeCommand } from "../../../../shared/cli/cli-params.ts";

export const inspectDbRoleConfigsCommand = makeCommand("role-configs", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show configuration settings for database roles when they have been modified. Deprecated: use "role-stats" instead.',
  ),
  Command.withShortDescription("Show role configs (deprecated)"),
  Command.withExamples([
    {
      command: "supabase inspect db role-configs",
      description: "Show modified role settings on the local database",
    },
    {
      command: "supabase inspect db role-configs --remote",
      description: "Show modified role settings on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbRoleConfigs)),
  Command.provide(inspectDbRuntimeLayer("role-configs")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
