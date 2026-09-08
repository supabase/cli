import { Command } from "effect/unstable/cli";
import { completionBashCommand } from "./bash/bash.command.ts";
import { completionFishCommand } from "./fish/fish.command.ts";
import { completionPowershellCommand } from "./powershell/powershell.command.ts";
import { completionZshCommand } from "./zsh/zsh.command.ts";

export const completionCommand = Command.make("completion").pipe(
  Command.withDescription(
    "Generate the autocompletion script for supabase for the specified shell.\n" +
      "See each sub-command's help for details on how to use the generated script.",
  ),
  Command.withShortDescription("Generate the autocompletion script for the specified shell"),
  Command.withSubcommands([
    completionBashCommand,
    completionFishCommand,
    completionPowershellCommand,
    completionZshCommand,
  ]),
);
