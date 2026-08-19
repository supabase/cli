import { Command } from "effect/unstable/cli";
import { legacyMigrationListCommand } from "./list/list.command.ts";
import { legacyMigrationNewCommand } from "./new/new.command.ts";
import { legacyMigrationRepairCommand } from "./repair/repair.command.ts";
import { legacyMigrationSquashCommand } from "./squash/squash.command.ts";
import { legacyMigrationUpCommand } from "./up/up.command.ts";
import { legacyMigrationDownCommand } from "./down/down.command.ts";
import { legacyMigrationFetchCommand } from "./fetch/fetch.command.ts";

export const legacyMigrationCommand = Command.make("migration").pipe(
  Command.withDescription("Manage database migration scripts."),
  Command.withShortDescription("Manage database migration scripts"),
  Command.withSubcommands([
    legacyMigrationListCommand,
    legacyMigrationNewCommand,
    legacyMigrationRepairCommand,
    legacyMigrationSquashCommand,
    legacyMigrationUpCommand,
    legacyMigrationDownCommand,
    legacyMigrationFetchCommand,
  ]),
);
