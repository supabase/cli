import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyFunctionsDelete } from "./delete.handler.ts";

const config = {
  functionName: Argument.string("Function name").pipe(
    Argument.withDescription("Name of the Function to delete."),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyFunctionsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyFunctionsDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription(
    "Delete a Function from the linked Supabase project. This does NOT remove the Function locally.",
  ),
  Command.withShortDescription("Delete a Function from Supabase"),
  Command.withHandler((flags) => legacyFunctionsDelete(flags)),
);
