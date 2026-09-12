import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { dbRemoteChanges } from "./changes.handler.ts";

const config = {
  schema: Flag.String("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  dbUrl: Flag.String("db-url").pipe(
    Flag.withDescription("Connect using the specified Postgres URL (must be percent-encoded)."),
    Flag.optional,
  ),
  linked: Flag.Boolean("linked").pipe(
    Flag.withDescription("Connect to the linked project."),
    Flag.withDefault(false),
  ),
  password: Flag.String("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type DbRemoteChangesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbRemoteChangesCommand = Command.make("changes", config).pipe(
  Command.withDescription("Show changes on the remote database since last migration."),
  Command.withShortDescription("Show changes on the remote database"),
  Command.withHandler((flags) => dbRemoteChanges(flags)),
);
