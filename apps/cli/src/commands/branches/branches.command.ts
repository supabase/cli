import { Command } from "effect/cli";
import { branchesListCommand } from "./list/list.command.ts";
import { branchesCreateCommand } from "./create/create.command.ts";
import { branchesGetCommand } from "./get/get.command.ts";
import { branchesUpdateCommand } from "./update/update.command.ts";
import { branchesPauseCommand } from "./pause/pause.command.ts";
import { branchesUnpauseCommand } from "./unpause/unpause.command.ts";
import { branchesDeleteCommand } from "./delete/delete.command.ts";
import { branchesDisableCommand } from "./disable/disable.command.ts";

export const branchesCommand = Command.make("branches").pipe(
  Command.withDescription(
    "Create, inspect, update, pause and delete the preview branches of the linked project. Each preview branch is an isolated environment for testing changes.",
  ),
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
