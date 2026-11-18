import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withPermissions } from "../../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackRestart } from "./restart.handler.ts";
import { withTargetPolicy } from "../../../../command-internal/target/target-policy.ts";
import { cliFlag, makeCommand } from "../../../../shared/cli/cli-params.ts";

const config = {
  stack: cliFlag("stack", Flag.String, {
    description: "Restart a named stack (defaults to the current project stack).",
    optional: true,
  }),
  stackId: cliFlag("stack-id", Flag.String, {
    description: "Restart an existing stack by id or unique id prefix.",
    optional: true,
  }),
} as const;

export type StackRestartFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackRestartCommand = makeCommand("restart", config).pipe(
  Command.withDescription(
    "Restart an existing managed local Supabase stack using its saved configuration, including the previous start's service selection and activation policy. Project config changes are not applied.",
  ),
  Command.withShortDescription("Restart a managed local stack"),
  Command.withExamples([
    {
      command: "supabase stack restart",
      description: "Restart the current project stack",
    },
  ]),
  withPermissions({ operations: [], noApiEffectFlags: ["stack", "stack-id"] }),
  Command.withHandler((flags) =>
    stackRestart(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
