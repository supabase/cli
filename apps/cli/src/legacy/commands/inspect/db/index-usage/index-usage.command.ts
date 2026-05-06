import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbIndexUsage } from "./index-usage.handler.ts";

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

export type LegacyInspectDbIndexUsageFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbIndexUsageCommand = Command.make("index-usage", config).pipe(
  Command.withDescription(
    'Show information about the efficiency of indexes. Deprecated: use "index-stats" instead.',
  ),
  Command.withShortDescription("Show index efficiency (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbIndexUsage(flags)),
);
