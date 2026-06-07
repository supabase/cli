import { Command } from "effect/unstable/cli";
import { legacyBackupsListCommand } from "./list/list.command.ts";
import { legacyBackupsRestoreCommand } from "./restore/restore.command.ts";

export const legacyBackupsCommand = Command.make("backups").pipe(
  Command.withDescription("Manage Supabase physical backups."),
  Command.withShortDescription("Manage Supabase physical backups"),
  Command.withSubcommands([legacyBackupsListCommand, legacyBackupsRestoreCommand]),
);
