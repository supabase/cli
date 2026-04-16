import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbVacuumStats } from "./vacuum-stats.handler.ts";

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

export type LegacyInspectDbVacuumStatsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbVacuumStatsCommand = Command.make("vacuum-stats", config).pipe(
  Command.withDescription("Show statistics related to vacuum operations per table."),
  Command.withShortDescription("Show vacuum stats"),
  Command.withHandler((flags) => legacyInspectDbVacuumStats(flags)),
);
