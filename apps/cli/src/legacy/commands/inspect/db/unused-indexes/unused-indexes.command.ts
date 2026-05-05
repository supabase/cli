import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbUnusedIndexes } from "./unused-indexes.handler.ts";

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

export type LegacyInspectDbUnusedIndexesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbUnusedIndexesCommand = Command.make("unused-indexes", config).pipe(
  Command.withDescription('Show indexes with low usage. Deprecated: use "index-stats" instead.'),
  Command.withShortDescription("Show unused indexes (deprecated)"),
  Command.withHandler((flags) => legacyInspectDbUnusedIndexes(flags)),
);
