import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyBranchesPause } from "./pause.handler.ts";

const config = {
  name: Argument.string("name").pipe(
    Argument.withDescription("Branch name or ID to pause."),
    Argument.optional,
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyBranchesPauseFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyBranchesPauseCommand = Command.make("pause", config).pipe(
  Command.withDescription("Pause a preview branch."),
  Command.withShortDescription("Pause a preview branch"),
  Command.withHandler((flags) => legacyBranchesPause(flags)),
);
