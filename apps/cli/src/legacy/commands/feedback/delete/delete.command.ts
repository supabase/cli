import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyTelemetryStateLayer } from "../../../telemetry/legacy-telemetry-state.layer.ts";
import { legacyFeedbackClientLayer, legacyFeedbackCliConfigLayer } from "../feedback.layers.ts";
import { LEGACY_FEEDBACK_OUTPUT_FORMATS } from "../feedback-output.ts";
import { legacyFeedbackDelete } from "./delete.handler.ts";

const config = {
  token: Argument.string("token").pipe(
    Argument.withDescription("Deletion token (UUID) printed when the feedback was submitted."),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project the feedback was submitted with."),
    Flag.optional,
  ),
} as const;

export type LegacyFeedbackDeleteArgs = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const legacyFeedbackDeleteHandler = (args: LegacyFeedbackDeleteArgs) =>
  legacyFeedbackDelete(args).pipe(
    // The token is a positional (structurally excluded from telemetry) and
    // `--project-ref` is a plain string flag, so its value is redacted.
    // Feedback's own `-o` enum is `pretty|json` (see feedback-output.ts).
    withLegacyCommandInstrumentation({
      flags: args,
      outputFormats: LEGACY_FEEDBACK_OUTPUT_FORMATS,
    }),
    withJsonErrorHandling,
  );

export const legacyFeedbackDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete previously submitted feedback using its deletion token."),
  Command.withShortDescription("Delete previously submitted feedback"),
  Command.withExamples([
    {
      command: "supabase feedback delete 123e4567-e89b-12d3-a456-426614174000",
      description: "Delete feedback using the token printed when it was submitted",
    },
  ]),
  Command.withHandler(legacyFeedbackDeleteHandler),
  Command.provide(commandRuntimeLayer(["feedback", "delete"])),
  Command.provide(legacyTelemetryStateLayer),
  // `Layer.provide` does not share to siblings: the handler and the feedback
  // client each get their own cli-config provision (legacy CLAUDE.md item 5).
  Command.provide(legacyFeedbackClientLayer),
  Command.provide(legacyFeedbackCliConfigLayer),
);
