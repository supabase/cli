import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { LegacyCompletionNoDescriptionsFlagDef } from "../completion.flags.ts";
import { legacyCompletionPowershell } from "./powershell.handler.ts";

const config = {
  noDescriptions: LegacyCompletionNoDescriptionsFlagDef,
} as const;
export type LegacyCompletionPowershellFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyCompletionPowershellCommand = Command.make("powershell", config).pipe(
  Command.withDescription(
    "Generate the autocompletion script for powershell.\n\n" +
      "To load completions in your current shell session:\n\n" +
      "\tsupabase completion powershell | Out-String | Invoke-Expression\n\n" +
      "To load completions for every new session, add the output of the above command\n" +
      "to your powershell profile.",
  ),
  Command.withShortDescription("Generate the autocompletion script for powershell"),
  Command.withHandler((flags) => legacyCompletionPowershell(flags)),
);
