import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbSchemaDeclarativeGenerate } from "./generate.handler.ts";

const config = {
  noCache: Flag.boolean("no-cache").pipe(
    Flag.withDescription("Disable catalog cache and force fresh shadow database setup."),
  ),
  overwrite: Flag.boolean("overwrite").pipe(
    Flag.withDescription("Overwrite declarative schema files without confirmation."),
  ),
  reset: Flag.boolean("reset").pipe(
    Flag.withDescription("Reset local database before generating (local data will be lost)."),
  ),
  schema: Flag.string("schema").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Comma separated list of schema to include."),
    Flag.atLeast(0),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Generates declarative schema from the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Generates declarative schema from the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Generates declarative schema from the local database."),
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyDbSchemaDeclarativeGenerateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbSchemaDeclarativeGenerateCommand = Command.make("generate", config).pipe(
  Command.withDescription("Generate declarative schema from a database."),
  Command.withShortDescription("Generate declarative schema from a database"),
  Command.withHandler((flags) => legacyDbSchemaDeclarativeGenerate(flags)),
);
