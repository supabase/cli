import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbIndexStats } from "./index-stats.handler.ts";
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

export const inspectDbIndexStatsCommand = makeCommand("index-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Report each index with its table, columns, size, the share of scans that used it, and whether it is unused. Use it to find large or unused indexes.",
  ),
  Command.withShortDescription("Show index stats"),
  Command.withExamples([
    {
      command: "supabase inspect db index-stats",
      description: "Show index stats for the local database",
    },
    {
      command: "supabase inspect db index-stats --remote",
      description: "Show index stats for the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbIndexStats)),
  Command.provide(inspectDbRuntimeLayer("index-stats")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
