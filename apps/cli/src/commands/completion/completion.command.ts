import { Command } from "effect/cli";
import { completionBashCommand } from "./bash/bash.command.ts";
import { completionFishCommand } from "./fish/fish.command.ts";
import { completionPowershellCommand } from "./powershell/powershell.command.ts";
import { completionZshCommand } from "./zsh/zsh.command.ts";

export const completionCommand = Command.make("completion").pipe(
  Command.withDescription(
    "Print a shell completion script for `supabase` to stdout. " +
      "Run the subcommand for your shell and follow its help to load the script.",
  ),
  Command.withShortDescription("Generate shell completion scripts"),
  Command.withSubcommands([
    completionBashCommand,
    completionFishCommand,
    completionPowershellCommand,
    completionZshCommand,
  ]),
);
