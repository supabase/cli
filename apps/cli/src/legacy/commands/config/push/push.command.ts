import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyConfigPush } from "./push.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyConfigPushFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyConfigPushCommand = Command.make("push", config).pipe(
  Command.withDescription("Pushes local config.toml to the linked project."),
  Command.withShortDescription("Push local config to linked project"),
  Command.withExamples([
    {
      command: "supabase config push",
      description: "Push local config to the linked project",
    },
    {
      command: "supabase config push --project-ref abcdefghijklmnopqrst",
      description: "Push local config to a specific project",
    },
  ]),
  Command.withHandler((flags) => legacyConfigPush(flags)),
);
