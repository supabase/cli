import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbIndexSizes } from "./index-sizes.handler.ts";
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

export const inspectDbIndexSizesCommand = makeCommand("index-sizes", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show index sizes of individual indexes. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show individual index sizes (deprecated)"),
  Command.withExamples([
    {
      command: "supabase inspect db index-sizes",
      description: "Show index sizes on the local database",
    },
    {
      command: "supabase inspect db index-sizes --remote",
      description: "Show index sizes on the linked project",
    },
  ]),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbIndexSizes)),
  Command.provide(inspectDbRuntimeLayer("index-sizes")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
