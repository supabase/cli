import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbDbStats } from "./db-stats.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
  withInspectDbTargetPolicy,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbDbStatsCommand = Command.make("db-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show stats such as cache hit rates, total sizes, and WAL size."),
  Command.withShortDescription("Show database stats"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbDbStats)),
  Command.provide(inspectDbRuntimeLayer("db-stats")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
