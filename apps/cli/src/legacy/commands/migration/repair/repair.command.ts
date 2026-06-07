import { Argument, Command, Flag } from "effect/unstable/cli";
import { legacyMigrationRepair } from "./repair.handler.ts";

const config = {
  versions: Argument.string("version").pipe(
    Argument.withDescription("Migration version(s) to repair."),
    Argument.variadic(),
  ),
  status: Flag.choice("status", ["applied", "reverted"] as const).pipe(
    Flag.withDescription("Version status to update."),
  ),
  dbUrl: Flag.string("db-url").pipe(
    Flag.withDescription(
      "Repairs migrations of the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Repairs the migration history of the linked project."),
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Repairs the migration history of the local database."),
  ),
  password: Flag.string("password").pipe(
    Flag.withAlias("p"),
    Flag.withDescription("Password to your remote Postgres database."),
    Flag.optional,
  ),
} as const;

export const legacyMigrationRepairCommand = Command.make("repair", config).pipe(
  Command.withDescription("Repair the migration history table."),
  Command.withShortDescription("Repair the migration history table"),
  Command.withHandler((flags) =>
    legacyMigrationRepair({
      versions: flags.versions.map(String),
      status: flags.status,
      dbUrl: flags.dbUrl,
      linked: flags.linked,
      local: flags.local,
      password: flags.password,
    }),
  ),
);
