import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { dbBranchSwitch } from "./switch.handler.ts";

const config = {
  branchName: Argument.String("branch name").pipe(
    Argument.withDescription("Name of the branch to switch to."),
  ),
} as const;

export type DbBranchSwitchFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbBranchSwitchCommand = Command.make("switch", config).pipe(
  Command.withDescription("Switch the active branch."),
  Command.withShortDescription("Switch the active branch"),
  Command.withHandler((flags) => dbBranchSwitch(flags)),
);
