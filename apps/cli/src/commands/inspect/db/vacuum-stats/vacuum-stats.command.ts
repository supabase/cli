import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbVacuumStats } from "./vacuum-stats.handler.ts";
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

export const inspectDbVacuumStatsCommand = makeCommand("vacuum-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show statistics related to vacuum operations per table."),
  Command.withShortDescription("Show vacuum stats"),
  Command.withExamples([
    {
      command: "supabase inspect db vacuum-stats",
      description: "Show vacuum stats on the local database",
    },
    {
      command: "supabase inspect db vacuum-stats --remote",
      description: "Show vacuum stats on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbVacuumStats)),
  Command.provide(inspectDbRuntimeLayer("vacuum-stats")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
