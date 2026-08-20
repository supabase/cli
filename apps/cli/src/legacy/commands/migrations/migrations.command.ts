import { Command } from "effect/unstable/cli";
import { legacyMigrationsApplyCommand } from "./apply/apply.command.ts";
import { legacyMigrationsDiffCommand } from "./diff/diff.command.ts";
import { legacyMigrationsListCommand } from "./list/list.command.ts";
import { legacyMigrationsNewCommand } from "./new/new.command.ts";
import { legacyMigrationsPullCommand } from "./pull/pull.command.ts";
import { legacyMigrationsPushCommand } from "./push/push.command.ts";

export const legacyMigrationsCommand = Command.make("migrations").pipe(
  Command.withDescription(
    "Work with supabase/migrations as the deployment recipe.\n\n" +
      "These commands do not load supabase/schemas. The only command that changes a remote schema is migrations push.",
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
