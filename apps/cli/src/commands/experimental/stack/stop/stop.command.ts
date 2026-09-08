import { Command, Flag } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyExperimentalStackStop } from "./stop.handler.ts";

const config = {
  all: Flag.boolean("all").pipe(
    Flag.withDescription("Stop every managed stack while preserving its data."),
    Flag.withDefault(false),
  ),
  stack: Flag.string("stack").pipe(
    Flag.withDescription("Stop the stack with this name (defaults to the current project stack)."),
    Flag.optional,
  ),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Stop an existing stack by id."),
    Flag.optional,
  ),
} as const;

export const legacyExperimentalStackStopCommand = Command.make("stop", config).pipe(
  Command.withDescription("Stop one or all managed local Supabase stacks while preserving data."),
  Command.withShortDescription("Stop a managed local stack"),
  Command.withExamples([
    {
      command: "supabase stack stop --stack feature-a",
      description: "Stop the existing feature-a stack",
    },
    {
      command: "supabase stack stop --all",
      description: "Stop every managed stack",
    },
  ]),
  Command.withHandler((flags) =>
    legacyExperimentalStackStop(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
);
