import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbRemoteCommit } from "./commit.handler.ts";

const config = {
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription("Connect using the specified Postgres URL (must be percent-encoded)."),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Connect to the linked project.")),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyDbRemoteCommitFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbRemoteCommitCommand = Command.make("commit", config).pipe(
  Command.withDescription("Commit remote changes as a new migration."),
  Command.withShortDescription("Commit remote changes as a new migration"),
  Command.withHandler((flags) => legacyDbRemoteCommit(flags)),
);
