import { Effect, Option } from "effect";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { FeedbackSubmitter } from "../../../shared/feedback/feedback-submitter.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { AiTool } from "../../../shared/telemetry/ai-tool.service.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import type { LegacyFeedbackArgs } from "./feedback.command.ts";
import {
  LEGACY_FEEDBACK_EMPTY_MESSAGE,
  LegacyFeedbackEmptyMessageError,
} from "./feedback.errors.ts";

// Resolution order: positional words → piped stdin (non-TTY) → interactive
// prompt (TTY, text mode only — json/stream-json layers report
// interactive: false) → LegacyFeedbackEmptyMessageError. Whitespace-only
// input falls through to the next source.
const legacyResolveFeedbackMessage = Effect.fnUntraced(function* (args: LegacyFeedbackArgs) {
  const fromArgs = args.message.join(" ").trim();
  if (fromArgs.length > 0) return fromArgs;

  const stdin = yield* Stdin;
  if (!stdin.isTTY) {
    const piped = yield* stdin.readPipedText;
    if (Option.isSome(piped)) {
      const fromPipe = piped.value.trim();
      if (fromPipe.length > 0) return fromPipe;
    }
  }

  const output = yield* Output;
  if (output.interactive) {
    const typed = yield* output.promptText("What's on your mind?", {
      validate: (value) =>
        value.trim().length === 0 ? "Feedback message cannot be empty." : undefined,
    });
    return typed.trim();
  }

  return yield* Effect.fail(
    new LegacyFeedbackEmptyMessageError({ message: LEGACY_FEEDBACK_EMPTY_MESSAGE }),
  );
});

export const legacyFeedback = Effect.fn("legacy.feedback")(function* (args: LegacyFeedbackArgs) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryRuntime = yield* TelemetryRuntime;
  const aiTool = yield* AiTool;
  const submitter = yield* FeedbackSubmitter;

  const message = yield* legacyResolveFeedbackMessage(args);

  const receipt = yield* submitter.submit({
    message,
    context: {
      cliVersion: telemetryRuntime.cliVersion,
      userAgent: cliConfig.userAgent,
      os: runtimeInfo.platform,
      arch: runtimeInfo.arch,
      isAgent: Option.isSome(aiTool.name),
      ...(Option.isSome(aiTool.name) ? { agentName: aiTool.name.value } : {}),
    },
  });

  yield* output.success("Thanks for the feedback!", {
    id: receipt.id,
    submitted_at: receipt.submittedAt,
  });
});
