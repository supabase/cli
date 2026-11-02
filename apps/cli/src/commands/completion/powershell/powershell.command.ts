import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { CompletionNoDescriptionsFlagDef } from "../completion.flags.ts";
import { completionPowershell } from "./powershell.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";

const config = {
  noDescriptions: CompletionNoDescriptionsFlagDef,
} as const;
export type CompletionPowershellFlags = CliCommand.Command.Config.Infer<typeof config>;

export const completionPowershellCommand = Command.make("powershell", config).pipe(
  Command.withDescription(
    "Generate the autocompletion script for powershell.\n\n" +
      "To load completions in your current shell session:\n\n" +
      "\tsupabase completion powershell | Out-String | Invoke-Expression\n\n" +
      "To load completions for every new session, add the output of the above command\n" +
      "to your powershell profile.",
  ),
  Command.withShortDescription("Generate the autocompletion script for powershell"),
  withPermissions({ operations: [], noApiEffectFlags: ["no-descriptions"] }),
  Command.withHandler((flags) =>
    completionPowershell(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["completion", "powershell"])),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
