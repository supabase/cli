import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbReset } from "./reset.handler.ts";

const noSqlPaths: ReadonlyArray<string> = [];

const config = {
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Resets the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Resets the linked project with local migrations."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Resets the local database with local migrations."),
  ),
  noSeed: Flag.boolean("no-seed").pipe(
    Flag.withDescription("Skip running the seed script after reset."),
  ),
  sqlPaths: Flag.string("sql-paths").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Override [db.seed].sql_paths for this reset. May be repeated; each value accepts a SQL file path or glob pattern relative to the supabase directory and force-enables seeding.",
    ),
    Flag.withDefault(noSqlPaths),
  ),
  version: Flag.string("version").pipe(
    Flag.withDescription("Reset up to the specified version."),
    Flag.optional,
  ),
  last: Flag.integer("last").pipe(
    Flag.withDescription("Reset up to the last n migration versions."),
    Flag.optional,
  ),
} as const;

export type LegacyDbResetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbResetCommand = Command.make("reset", config).pipe(
  Command.withDescription("Resets the local database to current migrations."),
  Command.withShortDescription("Resets the local database to current migrations"),
  Command.withHandler((flags) => legacyDbReset(flags)),
);
