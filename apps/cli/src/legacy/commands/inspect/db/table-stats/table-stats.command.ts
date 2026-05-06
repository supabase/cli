import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbTableStats } from "./table-stats.handler.ts";

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

export type LegacyInspectDbTableStatsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbTableStatsCommand = Command.make("table-stats", config).pipe(
  Command.withDescription("Show combined table size, index size, and estimated row count."),
  Command.withShortDescription("Show table stats"),
  Command.withHandler((flags) => legacyInspectDbTableStats(flags)),
);
