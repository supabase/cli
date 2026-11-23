import { withSidebar } from "../../command-internal/command-sidebar.ts";
import { Command } from "effect/cli";
import { backupsListCommand } from "./list/list.command.ts";
import { backupsRestoreCommand } from "./restore/restore.command.ts";

export const backupsCommand = Command.make("backups").pipe(
  withSidebar({ category: "backups", title: "Manage physical backups" }),
  Command.withDescription("Manage Supabase physical backups."),
  Command.withShortDescription("Manage Supabase physical backups"),
  Command.withSubcommands([backupsListCommand, backupsRestoreCommand]),
);
