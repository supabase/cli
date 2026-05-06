import { Argument, Command, Flag } from "effect/unstable/cli";
import { legacySecretsUnset } from "./unset.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  names: Argument.string("NAME").pipe(
    Argument.withDescription("Secret names to unset."),
    Argument.variadic(),
  ),
};

export const legacySecretsUnsetCommand = Command.make("unset", config).pipe(
  Command.withDescription("Unset a secret(s) from the linked Supabase project."),
  Command.withShortDescription("Unset a secret(s) on Supabase"),
  Command.withExamples([
    {
      command: "supabase secrets unset MY_SECRET",
      description: "Unset a secret by name",
    },
    {
      command: "supabase secrets unset MY_SECRET OTHER_SECRET",
      description: "Unset multiple secrets",
    },
  ]),
  Command.withHandler((flags) =>
    legacySecretsUnset({
      projectRef: flags.projectRef,
      names: flags.names.map(String),
    }),
  ),
);
