import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacySnippetsList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};
export type LegacySnippetsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySnippetsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all SQL snippets of the linked project."),
  Command.withShortDescription("List all SQL snippets"),
  Command.withExamples([
    {
      command: "supabase snippets list",
      description: "List all SQL snippets",
    },
    {
      command: "supabase snippets list --project-ref <ref>",
      description: "List snippets for a specific project",
    },
  ]),
  Command.withHandler((flags) => legacySnippetsList(flags)),
);
