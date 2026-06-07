import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbTotalTableSizes } from "./total-table-sizes.handler.ts";

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

export type LegacyInspectDbTotalTableSizesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbTotalTableSizesCommand = Command.make("total-table-sizes", config).pipe(
  Command.withDescription(
    'Show total table sizes, including table index sizes. Deprecated: use "table-stats" instead.',
  ),
  Command.withShortDescription("Show total table sizes (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbTotalTableSizes(flags)),
);
