import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyInspectDbOutliers } from "./outliers.handler.ts";

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

export type LegacyInspectDbOutliersFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyInspectDbOutliersCommand = Command.make("outliers", config).pipe(
  Command.withDescription("Show queries from pg_stat_statements ordered by total execution time."),
  Command.withShortDescription("Show query outliers by time"),
  Command.withHandler((flags) => legacyInspectDbOutliers(flags)),
);
