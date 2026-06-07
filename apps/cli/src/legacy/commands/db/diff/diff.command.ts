import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbDiff } from "./diff.handler.ts";

const config = {
  useMigra: Flag.boolean("use-migra").pipe(
    Flag.withDescription("Use migra to generate schema diff."),
  ),
  usePgAdmin: Flag.boolean("use-pgadmin").pipe(
    Flag.withDescription("Use pgAdmin to generate schema diff."),
  ),
  usePgSchema: Flag.boolean("use-pg-schema").pipe(
    Flag.withDescription("Use pg-schema-diff to generate schema diff."),
  ),
  usePgDelta: Flag.boolean("use-pg-delta").pipe(
    Flag.withDescription("Use pg-delta to generate schema diff."),
  ),
  from: Flag.string("from").pipe(
    Flag.withDescription("Diff from local, linked, migrations, or a Postgres URL."),
    Flag.optional,
  ),
  to: Flag.string("to").pipe(
    Flag.withDescription("Diff to local, linked, migrations, or a Postgres URL."),
    Flag.optional,
  ),
  output: Flag.string("output").pipe(
    Flag.withAlias("o"),
    Flag.withDescription("Write explicit diff output to a file path."),
    Flag.optional,
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Diffs against the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Diffs local migration files against the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Diffs local migration files against the local database."),
  ),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Saves schema diff to a new migration file."),
    Flag.optional,
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  paths: Argument.string("path").pipe(
    Argument.withDescription("Additional paths."),
    Argument.variadic(),
  ),
} as const;

export type LegacyDbDiffFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbDiffCommand = Command.make("diff", config).pipe(
  Command.withDescription("Diffs the local database for schema changes."),
  Command.withShortDescription("Diffs the local database for schema changes"),
  Command.withHandler((flags) => legacyDbDiff(flags)),
);
