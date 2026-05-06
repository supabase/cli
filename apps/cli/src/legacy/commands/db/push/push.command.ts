import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbPush } from "./push.handler.ts";

const config = {
  includeAll: Flag.boolean("include-all").pipe(
    Flag.withDescription("Include all migrations not found on remote history table."),
  ),
  includeRoles: Flag.boolean("include-roles").pipe(
    Flag.withDescription("Include custom roles from supabase/roles.sql."),
  ),
  includeSeed: Flag.boolean("include-seed").pipe(
    Flag.withDescription("Include seed data from your config."),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription(
      "Print the migrations that would be applied, but don't actually apply them.",
    ),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Pushes to the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(Flag.withDescription("Pushes to the linked project.")),
  local: Flag.boolean("local").pipe(Flag.withDescription("Pushes to the local database.")),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export type LegacyDbPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbPushCommand = Command.make("push", config).pipe(
  Command.withDescription("Push new migrations to the remote database."),
  Command.withShortDescription("Push new migrations to the remote database"),
  Command.withHandler((flags) => legacyDbPush(flags)),
);
