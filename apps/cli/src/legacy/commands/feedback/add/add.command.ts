import { Effect, Layer } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyCliConfigLayer } from "../../../config/legacy-cli-config.layer.ts";
import { legacyDebugLoggerLayer } from "../../../shared/legacy-debug-logger.layer.ts";
import {
  FEEDBACK_PRODUCTION,
  FEEDBACK_STAGING,
  type FeedbackEnvironment,
  feedbackSubmitterLayer,
} from "../../../../shared/feedback/feedback-submitter.layer.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { aiToolLayer } from "../../../../shared/telemetry/ai-tool.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyFeedbackAdd } from "./add.handler.ts";

const config = {
  message: Argument.string("message").pipe(
    Argument.withDescription("Freeform feedback. Bare words are joined with spaces."),
    Argument.variadic,
  ),
} as const;

export type LegacyFeedbackAddArgs = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const legacyFeedbackAddHandler = (args: LegacyFeedbackAddArgs) =>
  legacyFeedbackAdd(args).pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling);

// Profile → feedback environment, mirroring how the Management API url follows
// the resolved profile: staging profiles post to the staging project, with a
// production fallback for unknown and YAML-file profiles (`legacy-profile.ts`).
function legacyFeedbackEnvironment(profile: string): FeedbackEnvironment {
  switch (profile) {
    case "supabase-staging":
    case "supabase-local":
      return FEEDBACK_STAGING;
    default:
      return FEEDBACK_PRODUCTION;
  }
}

const legacyFeedbackCliConfigLayer = legacyCliConfigLayer.pipe(
  Layer.provide(legacyDebugLoggerLayer),
);

const legacyFeedbackSubmitterLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* LegacyCliConfig;
    return feedbackSubmitterLayer({ environment: legacyFeedbackEnvironment(config.profile) });
  }),
).pipe(Layer.provide(legacyFeedbackCliConfigLayer));

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
  Command.provide(stdinLayer),
  Command.provide(aiToolLayer),
  // `Layer.provide` does not share to siblings: the handler and the submitter
  // each get their own cli-config provision (legacy CLAUDE.md item 5).
  Command.provide(legacyFeedbackSubmitterLayer),
  Command.provide(legacyFeedbackCliConfigLayer),
);
