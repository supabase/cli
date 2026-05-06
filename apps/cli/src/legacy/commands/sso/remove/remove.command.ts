import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacySsoRemove } from "./remove.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  providerId: Argument.string("provider-id").pipe(
    Argument.withDescription("The ID of the SSO identity provider to remove."),
  ),
};
export type LegacySsoRemoveFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacySsoRemoveCommand = Command.make("remove", config).pipe(
  Command.withDescription(
    "Remove a connection to an already added SSO identity provider. Removing the provider will prevent existing users from logging in.",
  ),
  Command.withShortDescription("Remove an existing SSO identity provider"),
  Command.withExamples([
    {
      command:
        "supabase sso remove b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz",
      description: "Remove an SSO provider by ID",
    },
  ]),
  Command.withHandler((flags) => legacySsoRemove(flags)),
);
