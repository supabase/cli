import { Command } from "effect/unstable/cli";
import { legacyInspectDbRoleStats } from "./role-stats.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbRoleStatsCommand = Command.make(
  "role-stats",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Show information about roles on the database."),
  Command.withShortDescription("Show role stats"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbRoleStats)),
  Command.provide(legacyInspectDbRuntimeLayer("role-stats")),
);
