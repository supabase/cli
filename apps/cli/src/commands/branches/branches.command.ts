import { Command } from "effect/unstable/cli";
import { branchesListCommand } from "./list/list.command.ts";
import { branchesCreateCommand } from "./create/create.command.ts";
import { branchesGetCommand } from "./get/get.command.ts";
import { branchesUpdateCommand } from "./update/update.command.ts";
import { branchesPauseCommand } from "./pause/pause.command.ts";
import { branchesUnpauseCommand } from "./unpause/unpause.command.ts";
import { branchesDeleteCommand } from "./delete/delete.command.ts";
import { branchesDisableCommand } from "./disable/disable.command.ts";

export const branchesCommand = Command.make("branches").pipe(
  Command.withDescription("Manage Supabase preview branches."),
  Command.withShortDescription("Manage preview branches"),
  Command.withSubcommands([
    branchesListCommand,
    branchesCreateCommand,
    branchesGetCommand,
    branchesUpdateCommand,
    branchesPauseCommand,
    branchesUnpauseCommand,
    branchesDeleteCommand,
    branchesDisableCommand.pipe(Command.unlisted),
  ]),
);
