import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbRoleStats } from "./role-stats.handler.ts";

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

export type LegacyInspectDbRoleStatsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbRoleStatsCommand = Command.make("role-stats", config).pipe(
  Command.withDescription("Show information about roles on the database."),
  Command.withShortDescription("Show role stats"),
  Command.withHandler((flags) => legacyInspectDbRoleStats(flags)),
);
