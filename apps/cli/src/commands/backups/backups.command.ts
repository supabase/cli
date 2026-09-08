import { Command } from "effect/unstable/cli";
import { backupsListCommand } from "./list/list.command.ts";
import { backupsRestoreCommand } from "./restore/restore.command.ts";

export const backupsCommand = Command.make("backups").pipe(
  Command.withDescription("Manage Supabase physical backups."),
  Command.withShortDescription("Manage Supabase physical backups"),
  Command.withSubcommands([backupsListCommand, backupsRestoreCommand]),
);
