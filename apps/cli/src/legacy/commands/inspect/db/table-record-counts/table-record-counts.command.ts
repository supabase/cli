import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbTableRecordCounts } from "./table-record-counts.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Inspect the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Inspect the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Inspect the local database.")),
} as const;

export type LegacyInspectDbTableRecordCountsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbTableRecordCountsCommand = Command.make(
  "table-record-counts",
  config,
).pipe(
  Command.withDescription(
    'Show estimated number of rows per table. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table record counts (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbTableRecordCounts(flags)),
);
