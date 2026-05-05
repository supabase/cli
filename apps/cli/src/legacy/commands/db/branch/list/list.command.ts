import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDbBranchList } from "./list.handler.ts";

const config = {} as const;

export type LegacyDbBranchListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDbBranchListCommand = Command.make("list", config).pipe(
  Command.withDescription("List branches."),
  Command.withShortDescription("List branches"),
  Command.withHandler((flags) => legacyDbBranchList(flags)),
);
