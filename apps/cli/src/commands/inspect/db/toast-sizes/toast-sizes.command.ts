import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbToastSizes } from "./toast-sizes.handler.ts";
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

export const inspectDbToastSizesCommand = makeCommand("toast-sizes", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show TOAST table sizes and dead chunk counts for user tables."),
  Command.withShortDescription("Show TOAST table sizes and dead chunk counts"),
  Command.withExamples([
    {
      command: "supabase inspect db toast-sizes",
      description: "Show TOAST sizes on the local database",
    },
    {
      command: "supabase inspect db toast-sizes --remote",
      description: "Show TOAST sizes on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbToastSizes)),
  Command.provide(inspectDbRuntimeLayer("toast-sizes")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
