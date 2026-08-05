import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { LegacyCompletionNoDescriptionsFlagDef } from "../completion.flags.ts";
import { legacyCompletionBash } from "./bash.handler.ts";

const config = {
  noDescriptions: LegacyCompletionNoDescriptionsFlagDef,
} as const;
export type LegacyCompletionBashFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyCompletionBashCommand = Command.make("bash", config).pipe(
  Command.withDescription(
    "Generate the autocompletion script for the bash shell.\n\n" +
      "This script depends on the 'bash-completion' package.\n" +
      "If it is not installed already, you can install it via your OS's package manager.\n\n" +
      "To load completions in your current shell session:\n\n" +
      "\tsource <(supabase completion bash)\n\n" +
      "To load completions for every new session, execute once:\n\n" +
      "#### Linux:\n\n" +
      "\tsupabase completion bash > /etc/bash_completion.d/supabase\n\n" +
      "#### macOS:\n\n" +
      "\tsupabase completion bash > $(brew --prefix)/etc/bash_completion.d/supabase\n\n" +
      "You will need to start a new shell for this setup to take effect.",
  ),
  Command.withShortDescription("Generate the autocompletion script for bash"),
  Command.withHandler((flags) => legacyCompletionBash(flags)),
);
