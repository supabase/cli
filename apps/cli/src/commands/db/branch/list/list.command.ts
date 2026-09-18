import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { dbBranchList } from "./list.handler.ts";

const config = {} as const;

export type DbBranchListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbBranchListCommand = Command.make("list", config).pipe(
  Command.withDescription("List branches."),
  Command.withShortDescription("List branches"),
  Command.withHandler((flags) => dbBranchList(flags)),
);
