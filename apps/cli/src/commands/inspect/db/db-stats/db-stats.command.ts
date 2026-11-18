import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbDbStats } from "./db-stats.handler.ts";
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

export const inspectDbDbStatsCommand = makeCommand("db-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Report cache hit rates, database, table, index and TOAST sizes, WAL size, and the time since statistics were reset. Start here for a quick health check of a database.",
  ),
  Command.withShortDescription("Show database stats"),
  Command.withExamples([
    {
      command: "supabase inspect db db-stats",
      description: "Show database stats for the local database",
    },
    {
      command: "supabase inspect db db-stats --remote",
      description: "Show database stats for the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbDbStats)),
  Command.provide(inspectDbRuntimeLayer("db-stats")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
