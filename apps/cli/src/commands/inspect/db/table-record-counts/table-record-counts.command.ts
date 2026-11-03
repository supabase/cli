import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbTableRecordCounts } from "./table-record-counts.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
  withInspectDbTargetPolicy,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbTableRecordCountsCommand = Command.make(
  "table-record-counts",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show estimated number of rows per table. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table record counts (deprecated)"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbTableRecordCounts)),
  Command.provide(inspectDbRuntimeLayer("table-record-counts")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
