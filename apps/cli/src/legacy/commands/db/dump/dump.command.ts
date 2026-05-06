import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbDump } from "./dump.handler.ts";

const config = {
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Prints the pg_dump script that would be executed."),
  ),
  dataOnly: Flag.boolean("data-only").pipe(Flag.withDescription("Dumps only data records.")),
  useCopy: Flag.boolean("use-copy").pipe(
    Flag.withDescription("Use copy statements in place of inserts."),
  ),
  exclude: Flag.string("exclude").pipe(
    Flag.withAlias("x"),
    Flag.withDescription("List of schema.tables to exclude from data-only dump."),
    Flag.atLeast(0),
  ),
  roleOnly: Flag.boolean("role-only").pipe(Flag.withDescription("Dumps only cluster roles.")),
  keepComments: Flag.boolean("keep-comments").pipe(
    Flag.withDescription("Keeps commented lines from pg_dump output."),
  ),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("File path to save the dumped contents."),
    Flag.optional,
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Dumps from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Dumps from the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Dumps from the local database.")),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
} as const;

export type LegacyDbDumpFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbDumpCommand = Command.make("dump", config).pipe(
  Command.withDescription("Dumps data or schemas from the remote database."),
  Command.withShortDescription("Dumps data or schemas from the remote database"),
  Command.withHandler((flags) => legacyDbDump(flags)),
);
