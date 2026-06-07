import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyMigrationFetch } from "./fetch.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Fetches migrations from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Fetches migration history from the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Fetches migration history from the local database."),
  ),
} as const;

export type LegacyMigrationFetchFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationFetchCommand = Command.make("fetch", config).pipe(
  Command.withDescription("Fetch migration files from history table."),
  Command.withShortDescription("Fetch migration files from history table"),
  Command.withHandler((flags) => legacyMigrationFetch(flags)),
);
