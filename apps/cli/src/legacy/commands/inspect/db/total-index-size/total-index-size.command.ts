import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbTotalIndexSize } from "./total-index-size.handler.ts";

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

export type LegacyInspectDbTotalIndexSizeFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbTotalIndexSizeCommand = Command.make("total-index-size", config).pipe(
  Command.withDescription('Show total size of all indexes. Deprecated: use "index-stats" instead.'),
  Command.withShortDescription("Show total index size (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbTotalIndexSize(flags)),
);
