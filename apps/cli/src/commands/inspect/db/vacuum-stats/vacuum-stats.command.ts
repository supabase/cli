import { Command } from "effect/unstable/cli";
import { legacyInspectDbVacuumStats } from "./vacuum-stats.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbVacuumStatsCommand = Command.make(
  "vacuum-stats",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Show statistics related to vacuum operations per table."),
  Command.withShortDescription("Show vacuum stats"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbVacuumStats)),
  Command.provide(legacyInspectDbRuntimeLayer("vacuum-stats")),
);
