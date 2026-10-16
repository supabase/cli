import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { dbBranchList } from "./list.handler.ts";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";

const config = {} as const;

export type DbBranchListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbBranchListCommand = Command.make("list", config).pipe(
  Command.withDescription("List branches."),
  Command.withShortDescription("List branches"),
  withPermissions({ status: "unmapped", reason: "go-delegated" }),
  Command.withHandler((flags) => dbBranchList(flags)),
);
