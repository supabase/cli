import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDomainsActivate } from "./activate.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyDomainsActivateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDomainsActivateCommand = Command.make("activate", config).pipe(
  Command.withDescription(
    "Activates the custom hostname configuration for a project. This reconfigures your Supabase project to respond to requests on your custom hostname. After the custom hostname is activated, your project's auth services will no longer function on the Supabase-provisioned subdomain.",
  ),
  Command.withShortDescription("Activate the custom hostname for a project"),
  Command.withExamples([
    {
      command: "supabase domains activate --project-ref abcdefghijklmnopqrst",
      description: "Activate the custom hostname for a project",
    },
  ]),
  Command.withHandler((flags) => legacyDomainsActivate(flags)),
);
