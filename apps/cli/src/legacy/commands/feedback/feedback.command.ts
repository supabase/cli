import { Effect, Layer } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import { feedbackSubmitterLayer } from "../../../shared/feedback/feedback-submitter.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { aiToolLayer } from "../../../shared/telemetry/ai-tool.layer.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyFeedbackEnvironment } from "./feedback.env.ts";
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

const legacyFeedbackCliConfigLayer = legacyCliConfigLayer.pipe(
  Layer.provide(legacyDebugLoggerLayer),
);

// The feedback backend environment follows the resolved profile the same way
// the Management API url does: staging profiles post to the staging project.
const legacyFeedbackSubmitterLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* LegacyCliConfig;
    return feedbackSubmitterLayer({ environment: legacyFeedbackEnvironment(config.profile) });
  }),
).pipe(Layer.provide(legacyFeedbackCliConfigLayer));

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
  // `Layer.provide` does not share to siblings: the handler and the submitter
  // each get their own cli-config provision (legacy CLAUDE.md item 5).
  Command.provide(legacyFeedbackSubmitterLayer),
  Command.provide(legacyFeedbackCliConfigLayer),
);
