import { Command } from "effect/cli";
import { migrationListCommand } from "./list/list.command.ts";
import { migrationNewCommand } from "./new/new.command.ts";
import { migrationRepairCommand } from "./repair/repair.command.ts";
import { migrationSquashCommand } from "./squash/squash.command.ts";
import { migrationUpCommand } from "./up/up.command.ts";
import { migrationDownCommand } from "./down/down.command.ts";
import { migrationFetchCommand } from "./fetch/fetch.command.ts";

export const migrationCommand = Command.make("migration").pipe(
  Command.withDescription(
    "Create, list, apply, squash, and repair the SQL migration files in supabase/migrations and the migration history of a database.",
  ),
  Command.withShortDescription("Manage database migrations"),
  Command.withAlias("migrations"),
  Command.withSubcommands([
    migrationListCommand,
    migrationNewCommand,
    migrationRepairCommand,
    migrationSquashCommand,
    migrationUpCommand,
    migrationDownCommand,
    migrationFetchCommand,
  ]),
);
