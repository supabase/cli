import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyBranchesUnpause } from "./unpause.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Branch name or ID to unpause."),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyBranchesUnpauseFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyBranchesUnpauseCommand = Command.make("unpause", config).pipe(
  Command.withDescription("Unpause a preview branch."),
  Command.withShortDescription("Unpause a preview branch"),
  Command.withHandler((flags) => legacyBranchesUnpause(flags)),
);
