import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbSeqScans } from "./seq-scans.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbSeqScansCommand = Command.make("seq-scans", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    'Show number of sequential scans recorded against all tables. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show sequential scans (deprecated)"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbSeqScans)),
  Command.provide(inspectDbRuntimeLayer("seq-scans")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
);
