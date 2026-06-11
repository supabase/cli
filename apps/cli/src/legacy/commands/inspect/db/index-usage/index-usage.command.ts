import { Command } from "effect/unstable/cli";
import { legacyInspectDbIndexUsage } from "./index-usage.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbIndexUsageCommand = Command.make(
  "index-usage",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show information about the efficiency of indexes. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show index efficiency (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbIndexUsage)),
  Command.provide(legacyInspectDbRuntimeLayer("index-usage")),
);
