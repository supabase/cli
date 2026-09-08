import { Command } from "effect/unstable/cli";
import { inspectDbRoleStats } from "./role-stats.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbRoleStatsCommand = Command.make("role-stats", INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show information about roles on the database."),
  Command.withShortDescription("Show role stats"),
  Command.withHandler(inspectDbCommandHandler(inspectDbRoleStats)),
  Command.provide(inspectDbRuntimeLayer("role-stats")),
);
