import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../telemetry/command-telemetry.ts";
import { stackStop } from "./stop.handler.ts";

const config = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription("Stop the stack with this name (defaults to the current project stack)."),
    Flag.optional,
  ),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Stop an existing stack by id."),
    Flag.optional,
  ),
} as const;

export type StackStopFlags = CliCommand.Command.Config.Infer<typeof config>;

export const stackStopCommand = Command.make("stop", config).pipe(
  Command.withDescription("Stop a managed local Supabase stack while preserving its data."),
  Command.withShortDescription("Stop a managed local stack"),
  Command.withExamples([
    {
      command: "supabase stack stop --stack feature-a",
      description: "Stop the existing feature-a stack",
    },
  ]),
  Command.withHandler((flags) =>
    stackStop(flags).pipe(withCommandTelemetry({ flags, config }), withJsonErrorHandling),
  ),
);
