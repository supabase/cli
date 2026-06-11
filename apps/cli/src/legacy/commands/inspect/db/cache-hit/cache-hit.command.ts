import { Command } from "effect/unstable/cli";
import { legacyInspectDbCacheHit } from "./cache-hit.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbCacheHitCommand = Command.make(
  "cache-hit",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show cache hit rates for tables and indices. Deprecated: use "db-stats" instead.',
  ),
  Command.withShortDescription("Show cache hit rates (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbCacheHit)),
  Command.provide(legacyInspectDbRuntimeLayer("cache-hit")),
);
