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

export const inspectDbToastSizesCommand = Command.make("toast-sizes", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Displays TOAST table sizes and dead chunk counts for every user table that has overflow storage. " +
      "Autovacuum runs on TOAST relations independently, so dead chunks can accumulate even when the " +
      "main heap looks healthy.",
  ),
  Command.withShortDescription("Show TOAST table sizes and dead chunk counts"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbToastSizes)),
  Command.provide(inspectDbRuntimeLayer("toast-sizes")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
