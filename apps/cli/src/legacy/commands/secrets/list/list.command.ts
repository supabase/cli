import { Command, Flag } from "effect/unstable/cli";
import { legacySecretsList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};

export const legacySecretsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all secrets in the linked project."),
  Command.withShortDescription("List all secrets on Supabase"),
  Command.withExamples([
    {
      command: "supabase secrets list",
      description: "List all secrets for the linked project",
    },
    {
      command: "supabase secrets list --project-ref abcdefghijklmnopqrst",
      description: "List secrets for a specific project",
    },
  ]),
  Command.withHandler((flags) => legacySecretsList(flags)),
);
