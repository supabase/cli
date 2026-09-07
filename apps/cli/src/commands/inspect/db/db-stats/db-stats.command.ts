import { Command } from "effect/unstable/cli";
import { legacyInspectDbDbStats } from "./db-stats.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbDbStatsCommand = Command.make("db-stats", LEGACY_INSPECT_DB_FLAGS).pipe(
  Command.withDescription("Show stats such as cache hit rates, total sizes, and WAL size."),
  Command.withShortDescription("Show database stats"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbDbStats)),
  Command.provide(legacyInspectDbRuntimeLayer("db-stats")),
);
