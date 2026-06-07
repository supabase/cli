import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbDbStats } from "./db-stats.handler.ts";

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

export type LegacyInspectDbDbStatsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbDbStatsCommand = Command.make("db-stats", config).pipe(
  Command.withDescription("Show stats such as cache hit rates, total sizes, and WAL size."),
  Command.withShortDescription("Show database stats"),
  Command.withHandler((flags) => legacyInspectDbDbStats(flags)),
);
