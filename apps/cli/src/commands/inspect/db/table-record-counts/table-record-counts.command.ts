import { Command } from "effect/unstable/cli";
import { legacyInspectDbTableRecordCounts } from "./table-record-counts.handler.ts";
import {
  LEGACY_INSPECT_DB_FLAGS,
  legacyInspectDbCommandHandler,
} from "../legacy-inspect-db-command.ts";
import { legacyInspectDbRuntimeLayer } from "../db.layers.ts";

export const legacyInspectDbTableRecordCountsCommand = Command.make(
  "table-record-counts",
  LEGACY_INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show estimated number of rows per table. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table record counts (deprecated)"),
  Command.withHandler(legacyInspectDbCommandHandler(legacyInspectDbTableRecordCounts)),
  Command.provide(legacyInspectDbRuntimeLayer("table-record-counts")),
);
