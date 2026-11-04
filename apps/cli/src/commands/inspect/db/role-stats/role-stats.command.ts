import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbRoleStats } from "./role-stats.handler.ts";
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

export const inspectDbRoleStatsCommand = makeCommand("role-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Report each role with its active connections, connection limit, and custom configuration. Use it to see which role uses the most connections.",
  ),
  Command.withShortDescription("Show role stats"),
  Command.withExamples([
    {
      command: "supabase inspect db role-stats",
      description: "Show role stats for the local database",
    },
    {
      command: "supabase inspect db role-stats --remote",
      description: "Show role stats for the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbRoleStats)),
  Command.provide(inspectDbRuntimeLayer("role-stats")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
