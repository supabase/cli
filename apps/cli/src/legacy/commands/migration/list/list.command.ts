import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyMigrationList } from "./list.handler.ts";

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Lists migrations of the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Lists migrations applied to the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Lists migrations applied to the local database."),
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyMigrationListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationListCommand = Command.make("list", config).pipe(
  Command.withDescription("List local and remote migrations."),
  Command.withShortDescription("List local and remote migrations"),
  Command.withHandler((flags) => legacyMigrationList(flags)),
);
