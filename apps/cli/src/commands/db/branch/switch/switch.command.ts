import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbBranchSwitch } from "./switch.handler.ts";

const config = {
  branchName: Argument.string("branch name").pipe(
    Argument.withDescription("Name of the branch to switch to."),
  ),
} as const;

export type LegacyDbBranchSwitchFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbBranchSwitchCommand = Command.make("switch", config).pipe(
  Command.withDescription("Switch the active branch."),
  Command.withShortDescription("Switch the active branch"),
  Command.withHandler((flags) => legacyDbBranchSwitch(flags)),
);
