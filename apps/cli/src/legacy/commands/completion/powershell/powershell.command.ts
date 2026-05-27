import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { legacyCompletionPowershell } from "./powershell.handler.ts";

const config = {};
export type LegacyCompletionPowershellFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyCompletionPowershellCommand = Command.make("powershell", config).pipe(
  Command.withDescription("Generate the autocompletion script for powershell"),
  Command.withShortDescription("Generate the autocompletion script for powershell"),
  Command.withHandler((flags) => legacyCompletionPowershell(flags)),
);
