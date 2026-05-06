import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacySsoInfo } from "./info.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};
export type LegacySsoInfoFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySsoInfoCommand = Command.make("info", config).pipe(
  Command.withDescription(
    "Returns all of the important SSO information necessary for your project to be registered with a SAML 2.0 compatible identity provider.",
  ),
  Command.withShortDescription("Returns the SAML SSO settings required for the identity provider"),
  Command.withExamples([
    {
      command: "supabase sso info --project-ref mwjylndxudmiehsxhmmz",
      description: "Get SSO info for a project",
    },
  ]),
  Command.withHandler((flags) => legacySsoInfo(flags)),
);
