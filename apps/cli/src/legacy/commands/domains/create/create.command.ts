import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDomainsCreate } from "./create.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  customHostname: Flag.string("custom-hostname").pipe(
    Flag.withDescription("The custom hostname to use for your Supabase project."),
  ),
} as const;

export type LegacyDomainsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDomainsCreateCommand = Command.make("create", config).pipe(
  Command.withDescription(
    "Create a custom hostname for your Supabase project. Expects your custom hostname to have a CNAME record to your Supabase project's subdomain.",
  ),
  Command.withShortDescription("Create a custom hostname"),
  Command.withExamples([
    {
      command:
        "supabase domains create --custom-hostname example.com --project-ref abcdefghijklmnopqrst",
      description: "Create a custom hostname for a project",
    },
  ]),
  Command.withHandler((flags) => legacyDomainsCreate(flags)),
);
