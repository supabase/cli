import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackRestart } from "./restart.handler.ts";

const config = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription("Restart a named stack (defaults to the current project stack)."),
    Flag.optional,
  ),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Restart an existing stack by id."),
    Flag.optional,
  ),
} as const;

export type StackRestartFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackRestartCommand = Command.make("restart", config).pipe(
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
  Command.withHandler((flags) =>
    stackRestart(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
);
