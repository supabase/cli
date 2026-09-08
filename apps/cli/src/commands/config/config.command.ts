import { Command } from "effect/unstable/cli";
import { configDiffCommand } from "./diff/diff.command.ts";
import { configPullCommand } from "./pull/pull.command.ts";
import { configPushCommand } from "./push/push.command.ts";

export const configCommand = Command.make("config").pipe(
  Command.withDescription("Manage Supabase project configurations."),
  Command.withShortDescription("Manage project configurations"),
  Command.withSubcommands([configDiffCommand, configPullCommand, configPushCommand]),
);
