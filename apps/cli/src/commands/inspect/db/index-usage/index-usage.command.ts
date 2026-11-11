import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbIndexUsage } from "./index-usage.handler.ts";
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

export const inspectDbIndexUsageCommand = makeCommand("index-usage", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show information about the efficiency of indexes. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show index efficiency (deprecated)"),
  Command.withExamples([
    {
      command: "supabase inspect db index-usage",
      description: "Show index usage on the local database",
    },
    {
      command: "supabase inspect db index-usage --remote",
      description: "Show index usage on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbIndexUsage)),
  Command.provide(inspectDbRuntimeLayer("index-usage")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
