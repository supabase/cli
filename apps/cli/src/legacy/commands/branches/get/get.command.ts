import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyBranchesGet } from "./get.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Branch name or ID."),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyBranchesGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyBranchesGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Retrieve details of the specified preview branch."),
  Command.withShortDescription("Retrieve details of a preview branch"),
  Command.withHandler((flags) => legacyBranchesGet(flags)),
);
