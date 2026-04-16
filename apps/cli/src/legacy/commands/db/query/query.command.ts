import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbQuery } from "./query.handler.ts";

const config = {
  sql: Argument.string("sql").pipe(
    Argument.withDescription("SQL query to execute."),
    Argument.optional,
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Queries the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Queries the linked project's database via Management API."),
  ),
  local: Flag.boolean("local").pipe(Flag.withDescription("Queries the local database.")),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Path to a SQL file to execute."),
    Flag.optional,
  ),
  output: Flag.choice("output", ["json", "table", "csv"] as const).pipe(
    Flag.withAlias("o"),
    Flag.withDescription("Output format: table, json, or csv."),
    Flag.optional,
  ),
} as const;

export type LegacyDbQueryFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbQueryCommand = Command.make("query", config).pipe(
  Command.withDescription("Execute a SQL query against the database."),
  Command.withShortDescription("Execute a SQL query against the database"),
  Command.withHandler((flags) => legacyDbQuery(flags)),
);
