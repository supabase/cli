import { Command } from "effect/unstable/cli";
import { legacyInspectDbIndexStats } from "./index-stats.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbIndexStatsCommand = Command.make(
  "index-stats",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    "Show combined index size, usage percent, scan counts, and unused status.",
  ),
  Command.withShortDescription("Show index stats"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbIndexStats)),
  Command.provide(legacyInspectDbRuntimeLayer("index-stats")),
);
