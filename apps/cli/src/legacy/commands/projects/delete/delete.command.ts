import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyProjectsDelete } from "./delete.handler.ts";

const config = {
  ref: Argument.string("ref").pipe(
    Argument.withDescription("Project ref to delete."),
    Argument.optional,
  ),
};
export type LegacyProjectsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyProjectsDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete a Supabase project."),
  Command.withShortDescription("Delete a project"),
  Command.withExamples([
    {
      command: "supabase projects delete abcdefghijklmnopqrst",
      description: "Delete a project by ref",
    },
  ]),
  Command.withHandler((flags) => legacyProjectsDelete(flags)),
);
