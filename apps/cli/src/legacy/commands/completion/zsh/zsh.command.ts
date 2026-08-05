import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { LegacyCompletionNoDescriptionsFlagDef } from "../completion.flags.ts";
import { legacyCompletionZsh } from "./zsh.handler.ts";

const config = {
  noDescriptions: LegacyCompletionNoDescriptionsFlagDef,
} as const;
export type LegacyCompletionZshFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyCompletionZshCommand = Command.make("zsh", config).pipe(
  Command.withDescription(
    "Generate the autocompletion script for the zsh shell.\n\n" +
      "If shell completion is not already enabled in your environment you will need\n" +
      "to enable it.  You can execute the following once:\n\n" +
      '\techo "autoload -U compinit; compinit" >> ~/.zshrc\n\n' +
      "To load completions in your current shell session:\n\n" +
      "\tsource <(supabase completion zsh)\n\n" +
      "To load completions for every new session, execute once:\n\n" +
      "#### Linux:\n\n" +
      '\tsupabase completion zsh > "${fpath[1]}/_supabase"\n\n' +
      "#### macOS:\n\n" +
      "\tsupabase completion zsh > $(brew --prefix)/share/zsh/site-functions/_supabase\n\n" +
      "You will need to start a new shell for this setup to take effect.",
  ),
  Command.withShortDescription("Generate the autocompletion script for zsh"),
  Command.withHandler((flags) => legacyCompletionZsh(flags)),
);
