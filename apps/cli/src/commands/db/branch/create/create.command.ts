import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { dbBranchCreate } from "./create.handler.ts";

const config = {
  branchName: Argument.String("branch name").pipe(
    Argument.withDescription("Name for the new branch."),
  ),
} as const;

export type DbBranchCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbBranchCreateCommand = Command.make("create", config).pipe(
  Command.withDescription("Create a branch."),
  Command.withShortDescription("Create a branch"),
  Command.withHandler((flags) => dbBranchCreate(flags)),
);
