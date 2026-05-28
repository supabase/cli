import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyCompletionFish } from "./fish.handler.ts";

const config = {};
export type LegacyCompletionFishFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyCompletionFishCommand = Command.make("fish", config).pipe(
  Command.withDescription("Generate the autocompletion script for fish"),
  Command.withShortDescription("Generate the autocompletion script for fish"),
  Command.withHandler((flags) => legacyCompletionFish(flags)),
);
