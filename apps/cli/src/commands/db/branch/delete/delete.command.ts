import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { dbBranchDelete } from "./delete.handler.ts";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";

const config = {
  branchName: Argument.String("branch name").pipe(
    Argument.withDescription("Name of the branch to delete."),
  ),
} as const;

export type DbBranchDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const dbBranchDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete a branch."),
  Command.withShortDescription("Delete a branch"),
  withPermissions({ status: "unmapped", reason: "go-delegated" }),
  Command.withHandler((flags) => dbBranchDelete(flags)),
);
