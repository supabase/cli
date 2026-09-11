import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackStatus } from "./status.handler.ts";

const config = {
  stack: Flag.string("stack").pipe(Flag.withDescription("Inspect a named stack."), Flag.optional),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Inspect an existing stack by id."),
    Flag.optional,
  ),
} as const;

export type StackStatusFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackStatusCommand = Command.make("status", config).pipe(
  Command.withDescription("Show the state of a managed local Supabase stack."),
  Command.withShortDescription("Show stack status"),
  Command.withExamples([
    {
      command: "supabase stack status",
      description: "Show the current project stack",
    },
    {
      command: "supabase stack status --stack feature-a",
      description: "Show a named stack",
    },
  ]),
  Command.withHandler((flags) =>
    stackStatus(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
);
