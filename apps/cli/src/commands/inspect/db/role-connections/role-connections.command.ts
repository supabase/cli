import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbRoleConnections } from "./role-connections.handler.ts";
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

export const inspectDbRoleConnectionsCommand = makeCommand(
  "role-connections",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show number of active connections for all database roles. Deprecated: use "role-stats" instead.',
  ),
  Command.withShortDescription("Show role connections (deprecated)"),
  Command.withExamples([
    {
      command: "supabase inspect db role-connections",
      description: "Show active connections per role on the local database",
    },
    {
      command: "supabase inspect db role-connections --remote",
      description: "Show active connections per role on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbRoleConnections)),
  Command.provide(inspectDbRuntimeLayer("role-connections")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
