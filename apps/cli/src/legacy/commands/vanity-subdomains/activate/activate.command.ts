import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyVanitySubdomainsActivate } from "./activate.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  desiredSubdomain: Flag.string("desired-subdomain").pipe(
    Flag.withDescription("The desired vanity subdomain to use for your Supabase project."),
  ),
} as const;

export type LegacyVanitySubdomainsActivateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyVanitySubdomainsActivateCommand = Command.make("activate", config).pipe(
  Command.withDescription(
    "Activate a vanity subdomain for your Supabase project. This reconfigures your Supabase project to respond to requests on your vanity subdomain. After the vanity subdomain is activated, your project's auth services will no longer function on the {project-ref}.{supabase-domain} hostname.",
  ),
  Command.withShortDescription("Activate a vanity subdomain"),
  Command.withHandler((flags) => legacyVanitySubdomainsActivate(flags)),
);
