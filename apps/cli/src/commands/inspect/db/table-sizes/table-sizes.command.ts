import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbTableSizes } from "./table-sizes.handler.ts";
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

export const inspectDbTableSizesCommand = makeCommand("table-sizes", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show table sizes of individual tables without their index sizes. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table sizes (deprecated)"),
  Command.withExamples([
    {
      command: "supabase inspect db table-sizes",
      description: "Show table sizes on the local database",
    },
    {
      command: "supabase inspect db table-sizes --remote",
      description: "Show table sizes on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbTableSizes)),
  Command.provide(inspectDbRuntimeLayer("table-sizes")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
