import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbIndexStats } from "./index-stats.handler.ts";

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

export type LegacyInspectDbIndexStatsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbIndexStatsCommand = Command.make("index-stats", config).pipe(
  Command.withDescription(
    "Show combined index size, usage percent, scan counts, and unused status.",
  ),
  Command.withShortDescription("Show index stats"),
  Command.withHandler((flags) => legacyInspectDbIndexStats(flags)),
);
