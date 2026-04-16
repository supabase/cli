import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbPull } from "./pull.handler.ts";

const config = {
  name: Argument.string("migration name").pipe(
    Argument.withDescription("Optional name for the migration file."),
    Argument.optional,
  ),
  usePgDelta: Flag.boolean("use-pg-delta").pipe(
    Flag.withDescription("Use pg-delta to pull declarative schema."),
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Pulls from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Pulls from the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Pulls from the local database.")),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyDbPullFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbPullCommand = Command.make("pull", config).pipe(
  Command.withDescription("Pull schema from the remote database."),
  Command.withShortDescription("Pull schema from the remote database"),
  Command.withHandler((flags) => legacyDbPull(flags)),
);
