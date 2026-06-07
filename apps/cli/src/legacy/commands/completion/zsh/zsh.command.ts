import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyCompletionZsh } from "./zsh.handler.ts";

const config = {};
export type LegacyCompletionZshFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyCompletionZshCommand = Command.make("zsh", config).pipe(
  Command.withDescription("Generate the autocompletion script for zsh"),
  Command.withShortDescription("Generate the autocompletion script for zsh"),
  Command.withHandler((flags) => legacyCompletionZsh(flags)),
);
