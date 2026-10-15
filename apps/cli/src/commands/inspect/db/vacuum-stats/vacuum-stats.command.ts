import { Command } from "effect/cli";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { inspectDbVacuumStats } from "./vacuum-stats.handler.ts";
import {
  INSPECT_DB_FLAGS,
  INSPECT_DB_PERMISSIONS,
  inspectDbCommandHandler,
} from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbVacuumStatsCommand = Command.make("vacuum-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show statistics related to vacuum operations per table."),
  Command.withShortDescription("Show vacuum stats"),
  withPermissions(INSPECT_DB_PERMISSIONS),
  Command.withHandler(inspectDbCommandHandler(inspectDbVacuumStats)),
  Command.provide(inspectDbRuntimeLayer("vacuum-stats")),
);
