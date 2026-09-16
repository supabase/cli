import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { CompletionNoDescriptionsFlagDef } from "../completion.flags.ts";
import { completionFish } from "./fish.handler.ts";

const config = {
  noDescriptions: CompletionNoDescriptionsFlagDef,
} as const;
export type CompletionFishFlags = CliCommand.Command.Config.Infer<typeof config>;

export const completionFishCommand = Command.make("fish", config).pipe(
  Command.withDescription(
    "Generate the autocompletion script for the fish shell.\n\n" +
      "To load completions in your current shell session:\n\n" +
      "\tsupabase completion fish | source\n\n" +
      "To load completions for every new session, execute once:\n\n" +
      "\tsupabase completion fish > ~/.config/fish/completions/supabase.fish\n\n" +
      "You will need to start a new shell for this setup to take effect.",
  ),
  Command.withShortDescription("Generate the autocompletion script for fish"),
  Command.withHandler((flags) =>
    completionFish(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["completion", "fish"])),
);
