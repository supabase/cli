import { Command } from "effect/unstable/cli";
import { legacyInspectDbTableStats } from "./table-stats.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbTableStatsCommand = Command.make(
  "table-stats",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription("Show combined table size, index size, and estimated row count."),
  Command.withShortDescription("Show table stats"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbTableStats)),
  Command.provide(legacyInspectDbRuntimeLayer("table-stats")),
);
