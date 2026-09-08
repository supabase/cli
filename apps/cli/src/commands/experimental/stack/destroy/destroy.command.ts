import { Command, Flag } from "effect/unstable/cli";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../../telemetry/legacy-command-instrumentation.ts";
import { legacyExperimentalStackDestroy } from "./destroy.handler.ts";

const config = {
  stack: Flag.string("stack").pipe(
    Flag.withDescription(
      "Destroy the stack with this name (defaults to the current project stack).",
    ),
    Flag.optional,
  ),
  stackId: Flag.string("stack-id").pipe(
    Flag.withDescription("Destroy an existing stack by id."),
    Flag.optional,
  ),
} as const;

export const legacyExperimentalStackDestroyCommand = Command.make("destroy", config).pipe(
  Command.withDescription("Permanently destroy a managed local Supabase stack and its data."),
  Command.withShortDescription("Destroy a managed local stack"),
  Command.withExamples([
    {
      command: "supabase stack destroy --stack feature-a --yes",
      description: "Permanently destroy the feature-a stack",
    },
  ]),
  Command.withHandler((flags) =>
    legacyExperimentalStackDestroy(flags).pipe(
      withLegacyCommandInstrumentation({ flags, config }),
      withJsonErrorHandling,
    ),
  ),
);
