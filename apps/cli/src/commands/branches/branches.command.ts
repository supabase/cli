import { Command } from "effect/unstable/cli";
import { listBranchesCommand } from "./list/list.command.ts";

export const branchesCommand = Command.make("branches").pipe(
  Command.withDescription("Manage Supabase Branches for the linked project."),
  Command.withShortDescription("Manage branches"),
  Command.withSubcommands([listBranchesCommand]),
);
