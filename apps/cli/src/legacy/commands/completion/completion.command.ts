import { Command } from "effect/unstable/cli";
import { legacyCompletionBashCommand } from "./bash/bash.command.ts";
import { legacyCompletionFishCommand } from "./fish/fish.command.ts";
import { legacyCompletionPowershellCommand } from "./powershell/powershell.command.ts";
import { legacyCompletionZshCommand } from "./zsh/zsh.command.ts";

export const legacyCompletionCommand = Command.make("completion").pipe(
  Command.withDescription(
    "Generate the autocompletion script for supabase for the specified shell.\n" +
      "See each sub-command's help for details on how to use the generated script.",
  ),
  Command.withShortDescription("Generate autocompletion scripts"),
  Command.withSubcommands([
    legacyCompletionBashCommand,
    legacyCompletionFishCommand,
    legacyCompletionPowershellCommand,
    legacyCompletionZshCommand,
  ]),
);
