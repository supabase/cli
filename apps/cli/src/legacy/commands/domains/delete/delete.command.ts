import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyDomainsDelete } from "./delete.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyDomainsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyDomainsDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Deletes the custom hostname config for your project."),
  Command.withShortDescription("Delete the custom hostname config"),
  Command.withExamples([
    {
      command: "supabase domains delete --project-ref abcdefghijklmnopqrst",
      description: "Delete the custom hostname config for a project",
    },
  ]),
  Command.withHandler((flags) => legacyDomainsDelete(flags)),
);
