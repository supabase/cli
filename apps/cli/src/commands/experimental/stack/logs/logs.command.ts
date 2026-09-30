import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackLogs } from "./logs.handler.ts";

const config = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription(
      "Select an existing stack by name (defaults to the current project stack).",
    ),
    Flag.optional,
  ),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Read logs from an existing stack by id."),
    Flag.optional,
  ),
  service: Flag.string("service").pipe(
    Flag.withDescription(
      "Stream one service kind or instance ID; defaults to composition members.",
    ),
    Flag.optional,
  ),
} as const;

export type StackLogsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackLogsCommand = Command.make("logs", config).pipe(
  Command.withDescription("Stream live logs until interrupted; retained history is unavailable."),
  Command.withShortDescription("Stream managed local stack logs"),
  Command.withExamples([
    {
      command: "supabase stack logs --service database",
      description: "Stream new database logs",
    },
    {
      command: "supabase stack logs --output-format stream-json",
      description: "Stream new stack logs as structured events",
    },
  ]),
  Command.withHandler((flags) =>
    stackLogs(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
);
