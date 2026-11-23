import { withSidebar } from "../../../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbTableStats } from "./table-stats.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
  withInspectDbTargetPolicy,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";
import { cliConfigValuesLayer } from "../../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../../config/cli-config-flags.ts";

export const inspectDbTableStatsCommand = Command.make("table-stats", INSPECT_DB_FLAGS).pipe(
  withSidebar({ title: "Show sizes of individual tables" }),
  Command.withDescription("Show combined table size, index size, and estimated row count."),
  Command.withShortDescription("Show table stats"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbTableStats)),
  Command.provide(inspectDbRuntimeLayer("table-stats")),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(INSPECT_DB_FLAGS),
  withInspectDbTargetPolicy,
);
