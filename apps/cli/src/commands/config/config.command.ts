import { Command } from "effect/cli";
import { configConvertCommand } from "./convert/convert.command.ts";
import { configDiffCommand } from "./diff/diff.command.ts";
import { configPullCommand } from "./pull/pull.command.ts";
import { configPushCommand } from "./push/push.command.ts";
import { configValidateCommand } from "./validate/validate.command.ts";

export const configCommand = Command.make("config").pipe(
  Command.withDescription("Manage Supabase project configurations."),
  Command.withShortDescription("Manage project configurations"),
  Command.withSubcommands([
    configConvertCommand,
    configDiffCommand,
    configPullCommand,
    configPushCommand,
    configValidateCommand,
  ]),
);
