import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyFunctionsList } from "./list.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyFunctionsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyFunctionsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all Functions in the linked Supabase project."),
  Command.withShortDescription("List all Functions in Supabase"),
  Command.withHandler((flags) => legacyFunctionsList(flags)),
);
