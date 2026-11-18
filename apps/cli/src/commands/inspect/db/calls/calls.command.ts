import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbCalls } from "./calls.handler.ts";
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

export const inspectDbCallsCommand = makeCommand("calls", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show queries from pg_stat_statements ordered by total times called."),
  Command.withShortDescription("Show queries by call count"),
  Command.withExamples([
    {
      command: "supabase inspect db calls",
      description: "List the most frequently called queries on the local database",
    },
    {
      command: "supabase inspect db calls --remote",
      description: "List the most frequently called queries on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbCalls)),
  Command.provide(inspectDbRuntimeLayer("calls")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
