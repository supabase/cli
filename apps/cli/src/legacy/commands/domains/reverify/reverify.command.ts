import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDomainsReverify } from "./reverify.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyDomainsReverifyFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDomainsReverifyCommand = Command.make("reverify", config).pipe(
  Command.withDescription("Re-verify the custom hostname config for your project."),
  Command.withShortDescription("Re-verify the custom hostname config"),
  Command.withExamples([
    {
      command: "supabase domains reverify --project-ref abcdefghijklmnopqrst",
      description: "Re-verify the custom hostname for a project",
    },
  ]),
  Command.withHandler((flags) => legacyDomainsReverify(flags)),
);
