import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyCompletionBash } from "./bash.handler.ts";

const config = {};
export type LegacyCompletionBashFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyCompletionBashCommand = Command.make("bash", config).pipe(
  Command.withDescription("Generate the autocompletion script for bash"),
  Command.withShortDescription("Generate the autocompletion script for bash"),
  Command.withHandler((flags) => legacyCompletionBash(flags)),
);
