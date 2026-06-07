import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbTableSizes } from "./table-sizes.handler.ts";

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

export type LegacyInspectDbTableSizesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbTableSizesCommand = Command.make("table-sizes", config).pipe(
  Command.withDescription(
    'Show table sizes of individual tables without their index sizes. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table sizes (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbTableSizes(flags)),
);
