import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { dbBranchDelete } from "./delete.handler.ts";

const config = {
  branchName: Argument.String("branch name").pipe(
    Argument.withDescription("Name of the branch to delete."),
  ),
} as const;

export type DbBranchDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbBranchDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete a branch."),
  Command.withShortDescription("Delete a branch"),
  Command.withHandler((flags) => dbBranchDelete(flags)),
);
