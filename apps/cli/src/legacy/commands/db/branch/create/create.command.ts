import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbBranchCreate } from "./create.handler.ts";

const config = {
  branchName: Argument.string("branch name").pipe(
    Argument.withDescription("Name for the new branch."),
  ),
} as const;

export type LegacyDbBranchCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbBranchCreateCommand = Command.make("create", config).pipe(
  Command.withDescription("Create a branch."),
  Command.withShortDescription("Create a branch"),
  Command.withHandler((flags) => legacyDbBranchCreate(flags)),
);
