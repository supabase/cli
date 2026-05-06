import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbTableIndexSizes } from "./table-index-sizes.handler.ts";

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

export type LegacyInspectDbTableIndexSizesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbTableIndexSizesCommand = Command.make("table-index-sizes", config).pipe(
  Command.withDescription(
    'Show index sizes of individual tables. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show table index sizes (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbTableIndexSizes(flags)),
);
