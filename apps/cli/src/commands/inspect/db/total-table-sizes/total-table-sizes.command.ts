import { Command } from "effect/unstable/cli";
import { legacyInspectDbTotalTableSizes } from "./total-table-sizes.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbTotalTableSizesCommand = Command.make(
  "total-table-sizes",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show total table sizes, including table index sizes. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show total table sizes (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbTotalTableSizes)),
  Command.provide(legacyInspectDbRuntimeLayer("total-table-sizes")),
);
