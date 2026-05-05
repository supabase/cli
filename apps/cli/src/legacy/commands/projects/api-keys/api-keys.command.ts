import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyProjectsApiKeys } from "./api-keys.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};
export type LegacyProjectsApiKeysFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyProjectsApiKeysCommand = Command.make("api-keys", config).pipe(
  Command.withDescription("List all API keys for a Supabase project."),
  Command.withShortDescription("List API keys"),
  Command.withExamples([
    {
      command: "supabase projects api-keys --project-ref abcdefghijklmnopqrst",
      description: "List all API keys for a project",
    },
  ]),
  Command.withHandler((flags) => legacyProjectsApiKeys(flags)),
);
