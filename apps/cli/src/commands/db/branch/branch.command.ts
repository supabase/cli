import { Command } from "effect/unstable/cli";
import { dbBranchCreateCommand } from "./create/create.command.ts";
import { dbBranchDeleteCommand } from "./delete/delete.command.ts";
import { dbBranchListCommand } from "./list/list.command.ts";
import { dbBranchSwitchCommand } from "./switch/switch.command.ts";

export const dbBranchCommand = Command.make("branch").pipe(
  Command.withDescription("Manage local database branches."),
  Command.withShortDescription("Manage local database branches"),
  Command.withSubcommands([
    dbBranchCreateCommand,
    dbBranchDeleteCommand,
    dbBranchListCommand,
    dbBranchSwitchCommand,
  ]),
);
