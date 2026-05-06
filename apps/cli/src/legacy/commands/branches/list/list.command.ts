import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyBranchesList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyBranchesListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyBranchesListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all preview branches of the linked project."),
  Command.withShortDescription("List all preview branches"),
  Command.withHandler((flags) => legacyBranchesList(flags)),
);
