import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbTableStats } from "./table-stats.handler.ts";
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

export const inspectDbTableStatsCommand = makeCommand("table-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Report each table with its table, index and total size, estimated row count, and sequential scan count. Use it to find the largest tables and how they are scanned.",
  ),
  Command.withShortDescription("Show table stats"),
  Command.withExamples([
    {
      command: "supabase inspect db table-stats",
      description: "Show table stats for the local database",
    },
    {
      command: "supabase inspect db table-stats --remote",
      description: "Show table stats for the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbTableStats)),
  Command.provide(inspectDbRuntimeLayer("table-stats")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
