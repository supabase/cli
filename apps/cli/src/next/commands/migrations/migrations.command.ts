import { Command } from "effect/unstable/cli";
import { SCHEMA_ECOSYSTEM_MAPPING_HELP } from "../../../shared/schema/schema-ecosystem.ts";
import { migrationsApplyCommand } from "./apply/apply.command.ts";
import { migrationsDiffCommand } from "./diff/diff.command.ts";
import { migrationsListCommand } from "./list/list.command.ts";
import { migrationsNewCommand } from "./new/new.command.ts";
import { migrationsPullCommand } from "./pull/pull.command.ts";
import { migrationsPushCommand } from "./push/push.command.ts";

export const migrationsCommand = Command.make("migrations").pipe(
  Command.withDescription(
    "Advanced file-and-history database workflow.\n\n" +
      "These commands operate on supabase/migrations and do not load declarative SQL. " +
      "migrations push is the only path that mutates a durable remote schema.\n\n" +
      SCHEMA_ECOSYSTEM_MAPPING_HELP,
  ),
  Command.withShortDescription("Manage migration files and history"),
  Command.withSubcommands([
    migrationsNewCommand,
    migrationsListCommand,
    migrationsDiffCommand,
    migrationsApplyCommand,
    migrationsPushCommand,
    migrationsPullCommand,
  ]),
);
