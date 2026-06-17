import { Command } from "effect/unstable/cli";
import { legacyInspectDbUnusedIndexes } from "./unused-indexes.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbUnusedIndexesCommand = Command.make(
  "unused-indexes",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription('Show indexes with low usage. Deprecated: use "index-stats" instead.'),
  Command.withShortDescription("Show unused indexes (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbUnusedIndexes)),
  Command.provide(legacyInspectDbRuntimeLayer("unused-indexes")),
);
