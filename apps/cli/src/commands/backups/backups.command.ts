import { Command } from "effect/cli";
import { backupsListCommand } from "./list/list.command.ts";
import { backupsRestoreCommand } from "./restore/restore.command.ts";

export const backupsCommand = Command.make("backups").pipe(
  Command.withDescription(
    "List the physical backups of a project and restore it to a point in time (PITR).",
  ),
  Command.withShortDescription("Manage physical backups"),
  Command.withSubcommands([backupsListCommand, backupsRestoreCommand]),
);
