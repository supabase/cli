import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { commandFeedbackClientLayer, feedbackCliConfigLayer } from "../feedback.layers.ts";
import { FEEDBACK_OUTPUT_FORMATS } from "../feedback-output.ts";
import { feedbackDelete } from "./delete.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { cliArgument, cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  token: cliArgument("token", Argument.String, {
    description: "Deletion token (UUID) printed when the feedback was submitted.",
    required: true,
  }),
  projectRef: cliFlag("project-ref", Flag.String, {
    description: "Project ref the feedback was submitted with.",
    optional: true,
  }),
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

export const feedbackDeleteCommand = makeCommand("delete", config).pipe(
  Command.withDescription("Remove feedback you sent earlier. Use the deletion token printed when you submitted it."),
  Command.withShortDescription("Delete submitted feedback"),
  Command.withExamples([
    {
      command: "supabase feedback delete 123e4567-e89b-12d3-a456-426614174000",
      description: "Delete feedback using the token printed when it was submitted",
    },
  ]),
  withPermissions({ operations: [], noApiEffectFlags: ["project-ref"] }),
  Command.withHandler(feedbackDeleteHandler),
  Command.provide(commandRuntimeLayer(["feedback", "delete"])),
  Command.provide(telemetryStateLayer),
  // `Layer.provide` does not share to siblings: the handler and the feedback
  // client each get their own cli-config provision (CLI Agent Guide invariant 5).
  Command.provide(commandFeedbackClientLayer),
  Command.provide(feedbackCliConfigLayer),
  withTargetPolicy({ group: "account", consent: "no" }),
);
