import { Command } from "effect/unstable/cli";
import { legacyInspectDbTableSizes } from "./table-sizes.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbTableSizesCommand = Command.make(
  "table-sizes",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show table sizes of individual tables without their index sizes. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table sizes (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbTableSizes)),
  Command.provide(legacyInspectDbRuntimeLayer("table-sizes")),
);
