import { Command } from "effect/unstable/cli";
import { legacyDbBranchCreateCommand } from "./create/create.command.ts";
import { legacyDbBranchDeleteCommand } from "./delete/delete.command.ts";
import { legacyDbBranchListCommand } from "./list/list.command.ts";
import { legacyDbBranchSwitchCommand } from "./switch/switch.command.ts";

export const legacyDbBranchCommand = Command.make("branch").pipe(
  Command.withDescription("Manage local database branches."),
  Command.withShortDescription("Manage local database branches"),
  Command.withSubcommands([
    legacyDbBranchCreateCommand,
    legacyDbBranchDeleteCommand,
    legacyDbBranchListCommand,
    legacyDbBranchSwitchCommand,
  ]),
);
