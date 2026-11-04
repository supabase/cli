import { Command } from "effect/cli";
import { configDiffCommand } from "./diff/diff.command.ts";
import { configPullCommand } from "./pull/pull.command.ts";
import { configPushCommand } from "./push/push.command.ts";

export const configCommand = Command.make("config").pipe(
  Command.withDescription(
    "Compare, pull and push the settings in `supabase/config.toml` against a project or branch, to manage project configuration as code.",
  ),
  Command.withShortDescription("Manage project configuration"),
  Command.withSubcommands([configDiffCommand, configPullCommand, configPushCommand]),
);
