import { Command } from "effect/unstable/cli";
import { legacyInspectDbTableIndexSizes } from "./table-index-sizes.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbTableIndexSizesCommand = Command.make(
  "table-index-sizes",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show index sizes of individual tables. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table index sizes (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbTableIndexSizes)),
  Command.provide(legacyInspectDbRuntimeLayer("table-index-sizes")),
);
