import { Command } from "effect/unstable/cli";
import { withHiddenSubcommands } from "../../../shared/cli/hidden-flag.ts";
import { legacyBranchesListCommand } from "./list/list.command.ts";
import { legacyBranchesCreateCommand } from "./create/create.command.ts";
import { legacyBranchesGetCommand } from "./get/get.command.ts";
import { legacyBranchesUpdateCommand } from "./update/update.command.ts";
import { legacyBranchesPauseCommand } from "./pause/pause.command.ts";
import { legacyBranchesUnpauseCommand } from "./unpause/unpause.command.ts";
import { legacyBranchesDeleteCommand } from "./delete/delete.command.ts";
import { legacyBranchesDisableCommand } from "./disable/disable.command.ts";

export const legacyBranchesCommand = Command.make("branches").pipe(
  Command.withDescription("Manage Supabase preview branches."),
  Command.withShortDescription("Manage preview branches"),
  withHiddenSubcommands(["disable"]),
  Command.withSubcommands([
    legacyBranchesListCommand,
    legacyBranchesCreateCommand,
    legacyBranchesGetCommand,
    legacyBranchesUpdateCommand,
    legacyBranchesPauseCommand,
    legacyBranchesUnpauseCommand,
    legacyBranchesDeleteCommand,
    legacyBranchesDisableCommand,
  ]),
);
