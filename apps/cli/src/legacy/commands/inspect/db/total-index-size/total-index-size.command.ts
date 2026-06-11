import { Command } from "effect/unstable/cli";
import { legacyInspectDbTotalIndexSize } from "./total-index-size.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbTotalIndexSizeCommand = Command.make(
  "total-index-size",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription('Show total size of all indexes. Deprecated: use "index-stats" instead.'),
  Command.withShortDescription("Show total index size (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbTotalIndexSize)),
  Command.provide(legacyInspectDbRuntimeLayer("total-index-size")),
);
