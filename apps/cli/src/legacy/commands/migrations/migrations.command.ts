import { Command } from "effect/unstable/cli";
import { SCHEMA_ECOSYSTEM_MAPPING_HELP } from "../../../shared/schema/schema-ecosystem.ts";
import { legacyMigrationsApplyCommand } from "./apply/apply.command.ts";
import { legacyMigrationsDiffCommand } from "./diff/diff.command.ts";
import { legacyMigrationsListCommand } from "./list/list.command.ts";
import { legacyMigrationsNewCommand } from "./new/new.command.ts";
import { legacyMigrationsPullCommand } from "./pull/pull.command.ts";
import { legacyMigrationsPushCommand } from "./push/push.command.ts";

export const legacyMigrationsCommand = Command.make("migrations").pipe(
  Command.withDescription(
    "Advanced file-and-history database workflow.\n\n" +
      "These commands operate on supabase/migrations and do not load declarative SQL. " +
      "migrations push is the only path that mutates a durable remote schema.\n\n" +
      SCHEMA_ECOSYSTEM_MAPPING_HELP,
  ),
  Command.withShortDescription("Manage migration files and history"),
  Command.withSubcommands([
    legacyMigrationsNewCommand,
    legacyMigrationsListCommand,
    legacyMigrationsDiffCommand,
    legacyMigrationsApplyCommand,
    legacyMigrationsPushCommand,
    legacyMigrationsPullCommand,
  ]),
);
