import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { aiToolLayer } from "../../../../shared/telemetry/ai-tool.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyFeedbackClientLayer, legacyFeedbackCliConfigLayer } from "../feedback.layers.ts";
import { LEGACY_FEEDBACK_OUTPUT_FORMATS } from "../feedback-output.ts";
import { legacyFeedbackAdd } from "./add.handler.ts";

const config = {
  message: Argument.string("message").pipe(
    Argument.withDescription(
      "Freeform feedback. Bare words are joined with spaces. 1000 character limit.",
    ),
    Argument.variadic,
  ),
} as const;

export type LegacyFeedbackAddArgs = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const legacyFeedbackAddHandler = (args: LegacyFeedbackAddArgs) =>
  legacyFeedbackAdd(args).pipe(
    // Feedback's own `-o` enum is `pretty|json`, not the resource-command set
    // (see feedback-output.ts).
    withLegacyCommandInstrumentation({ outputFormats: LEGACY_FEEDBACK_OUTPUT_FORMATS }),
    withJsonErrorHandling,
  );

export const legacyFeedbackAddCommand = Command.make("add", config).pipe(
  Command.withDescription("Send quick feedback about the Supabase CLI to the Supabase team."),
  Command.withShortDescription("Send feedback to the Supabase team"),
  Command.withExamples([
    {
      command:
        'supabase feedback add "when I run multiple stacks in parallel I get port conflicts"',
      description: "Send quick feedback about a papercut in one line",
    },
    {
      command: 'supabase feedback add -- "--yes should be the default in CI"',
      description: "Use -- when the message starts with a dash",
    },
  ]),
  Command.withHandler(legacyFeedbackAddHandler),
  Command.provide(commandRuntimeLayer(["feedback", "add"])),
  Command.provide(legacyTelemetryStateLayer),
  Command.provide(stdinLayer),
  Command.provide(aiToolLayer),
  // `Layer.provide` does not share to siblings: the handler and the feedback
  // client each get their own cli-config provision (legacy CLAUDE.md item 5).
  Command.provide(legacyFeedbackClientLayer),
  Command.provide(legacyFeedbackCliConfigLayer),
);
