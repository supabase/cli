import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { feedbackSubmitterStubLayer } from "../../../shared/feedback/feedback-submitter.stub.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { aiToolLayer } from "../../../shared/telemetry/ai-tool.layer.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyFeedback } from "./feedback.handler.ts";

const config = {
  message: Argument.string("message").pipe(
    Argument.withDescription("Freeform feedback. Bare words are joined with spaces."),
    Argument.variadic,
  ),
} as const;

export type LegacyFeedbackArgs = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const legacyFeedbackHandler = (args: LegacyFeedbackArgs) =>
  legacyFeedback(args).pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling);

export const legacyFeedbackCommand = Command.make("feedback", config).pipe(
  Command.withAlias("btw"),
  Command.withDescription("Send quick feedback about the Supabase CLI to the Supabase team."),
  Command.withShortDescription("Send feedback to the Supabase team"),
  Command.withExamples([
    {
      command: 'supabase btw "when I run multiple stacks in parallel I get port conflicts"',
      description: "Send quick feedback about a papercut in one line",
    },
    {
      command: 'supabase feedback -- "--yes should be the default in CI"',
      description: "Use -- when the message starts with a dash",
    },
  ]),
  Command.withHandler(legacyFeedbackHandler),
  Command.provide(commandRuntimeLayer(["feedback"])),
  Command.provide(stdinLayer),
  Command.provide(aiToolLayer),
  Command.provide(feedbackSubmitterStubLayer),
);
