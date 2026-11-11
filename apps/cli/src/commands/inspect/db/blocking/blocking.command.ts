import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbBlocking } from "./blocking.handler.ts";
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

export const inspectDbBlockingCommand = makeCommand("blocking", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Show queries that are holding locks and the queries that are waiting for them to be released.",
  ),
  Command.withShortDescription("Show blocking queries"),
  Command.withExamples([
    {
      command: "supabase inspect db blocking",
      description: "Show blocked statements on the local database",
    },
    {
      command: "supabase inspect db blocking --remote",
      description: "Show blocked statements on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbBlocking)),
  Command.provide(inspectDbRuntimeLayer("blocking")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
