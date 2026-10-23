import { Argument, Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_OUTCOMES,
} from "../../../shared/feedback/feedback-client.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stdinLayer } from "../../../shared/runtime/stdin.layer.ts";
import { aiToolLayer } from "../../../shared/telemetry/ai-tool.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import { commandFeedbackClientLayer, feedbackCliConfigLayer } from "../feedback.layers.ts";
import { FEEDBACK_OUTPUT_FORMATS } from "../feedback-output.ts";
import { feedbackAdd } from "./add.handler.ts";
import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";

const config = {
  message: Argument.String("message").pipe(
    Argument.withDescription(
      "Freeform feedback. Bare words are joined with spaces. 1000 character limit.",
    ),
    Argument.variadic(),
  ),
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription(
      "Project ref to attribute the feedback to (defaults to SUPABASE_PROJECT_ID, then the linked project).",
    ),
    Flag.optional,
  ),
  target: Flag.String("target").pipe(
    Flag.withDescription(
      'Docs section the feedback is about, as JSON: {"url":"https://supabase.com/docs/...","quote":"...","heading":"..."}. Repeat up to 3 times. URL under https://supabase.com/docs, /kb or llms.txt; quote 1-400 characters, copied verbatim; heading at most 200.',
    ),
    Flag.atMost(3),
  ),
  category: Flag.Literals("category", FEEDBACK_CATEGORIES).pipe(
    Flag.withDescription("Type of docs problem the feedback is about."),
    Flag.optional,
  ),
  outcome: Flag.Literals("outcome", FEEDBACK_OUTCOMES).pipe(
    Flag.withDescription("Final effect of the problem on your task."),
    Flag.optional,
  ),
} as const;

export type FeedbackAddArgs = CliCommand.Command.Config.Infer<typeof config>;

// Exported so integration tests can drive the exact wiring `Command.withHandler`
// uses below, instead of re-asserting the generic instrumentation mechanism.
export const feedbackAddHandler = (args: FeedbackAddArgs) =>
  feedbackAdd(args).pipe(
    // The message is a positional (structurally excluded from telemetry) and
    // `--project-ref` and `--target` are plain string flags, so their values
    // are redacted — the same treatment as `feedback delete`. `config` lets
    // the `--category`/`--outcome` choice values through. Feedback's own `-o`
    // enum is `pretty|json` (see feedback-output.ts).
    withCommandTelemetry({ flags: args, config, outputFormats: FEEDBACK_OUTPUT_FORMATS }),
    withJsonErrorHandling,
  );

export const feedbackAddCommand = Command.make("add", config).pipe(
  Command.withDescription(
    "Send quick feedback about the Supabase CLI or docs to the Supabase team.",
  ),
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
    {
      command: 'supabase feedback add --project-ref abcdefghijklmnopqrst "branching is slow here"',
      description: "Attribute the feedback to a project from an unlinked directory",
    },
    {
      command:
        'supabase feedback add --category missing_information --outcome worked_around --target \'{"url":"https://supabase.com/docs/guides/auth/server-side","quote":"Create a server client."}\' "the guide does not say who refreshes the session"',
      description: "Report a docs problem with the section it is about",
    },
  ]),
  withPermissions({
    operations: [],
    noApiEffectFlags: ["project-ref", "target", "category", "outcome"],
  }),
  Command.withHandler(feedbackAddHandler),
  Command.provide(commandRuntimeLayer(["feedback", "add"])),
  Command.provide(telemetryStateLayer),
  Command.provide(stdinLayer),
  Command.provide(aiToolLayer),
  // `Layer.provide` does not share to siblings: the handler and the feedback
  // client each get their own cli-config provision (CLI Agent Guide invariant 5).
  Command.provide(commandFeedbackClientLayer),
  Command.provide(feedbackCliConfigLayer),
);
