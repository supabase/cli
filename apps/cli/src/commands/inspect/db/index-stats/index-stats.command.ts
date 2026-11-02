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

export const inspectDbIndexStatsCommand = Command.make("index-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription(
    "Show combined index size, usage percent, scan counts, and unused status.",
  ),
  Command.withShortDescription("Show index stats"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbIndexStats)),
  Command.provide(inspectDbRuntimeLayer("index-stats")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
