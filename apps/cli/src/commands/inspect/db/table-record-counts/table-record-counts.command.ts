import { Command } from "effect/unstable/cli";
import { inspectDbTableRecordCounts } from "./table-record-counts.handler.ts";
import { INSPECT_DB_FLAGS, inspectDbCommandHandler } from "../inspect-db-command.ts";
import { inspectDbRuntimeLayer } from "../db.layers.ts";

export const inspectDbTableRecordCountsCommand = Command.make(
  "table-record-counts",
  INSPECT_DB_FLAGS,
).pipe(
  Command.withDescription(
    'Show estimated number of rows per table. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table record counts (deprecated)"),
  Command.withHandler(inspectDbCommandHandler(inspectDbTableRecordCounts)),
  Command.provide(inspectDbRuntimeLayer("table-record-counts")),
);
