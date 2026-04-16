import { Argument, Command, Flag } from "effect/unstable/cli";
import { legacySecretsSet } from "./set.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  envFile: Flag.string("env-file").pipe(
    Flag.withDescription("Read secrets from a .env file."),
    Flag.optional,
  ),
  secrets: Argument.string("NAME=VALUE").pipe(
    Argument.withDescription("Secret name=value pairs to set."),
    Argument.variadic(),
  ),
};

export const legacySecretsSetCommand = Command.make("set", config).pipe(
  Command.withDescription("Set a secret(s) to the linked Supabase project."),
  Command.withShortDescription("Set a secret(s) on Supabase"),
  Command.withExamples([
    {
      command: "supabase secrets set MY_SECRET=myvalue",
      description: "Set a secret by name and value",
    },
    {
      command: "supabase secrets set --env-file .env",
      description: "Set secrets from a .env file",
    },
  ]),
  Command.withHandler((flags) =>
    legacySecretsSet({
      projectRef: flags.projectRef,
      envFile: flags.envFile,
      secrets: flags.secrets.map(String),
    }),
  ),
);
