import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDomainsGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyDomainsGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDomainsGetCommand = Command.make("get", config).pipe(
  Command.withDescription(
    "Retrieve the custom hostname config for your project, as stored in the Supabase platform.",
  ),
  Command.withShortDescription("Get the current custom hostname config"),
  Command.withExamples([
    {
      command: "supabase domains get --project-ref abcdefghijklmnopqrst",
      description: "Get the custom hostname config for a project",
    },
  ]),
  Command.withHandler((flags) => legacyDomainsGet(flags)),
);
