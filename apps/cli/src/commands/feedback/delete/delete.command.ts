import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { commandFeedbackClientLayer, feedbackCliConfigLayer } from "../feedback.layers.ts";
import { FEEDBACK_OUTPUT_FORMATS } from "../feedback-output.ts";
import { feedbackDelete } from "./delete.handler.ts";

const config = {
  token: Argument.String("token").pipe(
    Argument.withDescription("Deletion token (UUID) printed when the feedback was submitted."),
  ),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project the feedback was submitted with."),
    Flag.optional,
  ),
} as const;

export type FeedbackDeleteArgs = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const feedbackDeleteHandler = (args: FeedbackDeleteArgs) =>
  feedbackDelete(args).pipe(
    // The token is a positional (structurally excluded from telemetry) and
    // `--project-ref` is a plain string flag, so its value is redacted.
    // Feedback's own `-o` enum is `pretty|json` (see feedback-output.ts).
    withCommandTelemetry({
      flags: args,
      outputFormats: FEEDBACK_OUTPUT_FORMATS,
    }),
    withJsonErrorHandling,
  );

export const feedbackDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete previously submitted feedback using its deletion token."),
  Command.withShortDescription("Delete previously submitted feedback"),
  Command.withExamples([
    {
      command: "supabase feedback delete 123e4567-e89b-12d3-a456-426614174000",
      description: "Delete feedback using the token printed when it was submitted",
    },
  ]),
  Command.withHandler(feedbackDeleteHandler),
  Command.provide(commandRuntimeLayer(["feedback", "delete"])),
  Command.provide(telemetryStateLayer),
  Command.provide(stdinLayer),
  // `Layer.provide` does not share to siblings: the handler and the feedback
  // client each get their own cli-config provision (CLI Agent Guide invariant 5).
  Command.provide(commandFeedbackClientLayer),
  Command.provide(feedbackCliConfigLayer),
);
