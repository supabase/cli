import { Effect, Option } from "effect";
import { FeedbackClient } from "../../../../shared/feedback/feedback-client.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { AiTool } from "../../../../shared/telemetry/ai-tool.service.ts";
import { TelemetryRuntime } from "../../../../shared/telemetry/runtime.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyResolveFeedbackProjectRef } from "../feedback-project-ref.ts";
import type { LegacyFeedbackAddArgs } from "./add.command.ts";
import { LEGACY_FEEDBACK_EMPTY_MESSAGE, LegacyFeedbackEmptyMessageError } from "./add.errors.ts";

// Resolution order: positional words → piped stdin (non-TTY) → interactive
// prompt (TTY, text mode only — json/stream-json layers report
// interactive: false) → LegacyFeedbackEmptyMessageError. Whitespace-only
// input falls through to the next source.
const legacyResolveFeedbackMessage = Effect.fnUntraced(function* (args: LegacyFeedbackAddArgs) {
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

export const legacyFeedbackAdd = Effect.fn("legacy.feedback.add")(function* (
  args: LegacyFeedbackAddArgs,
) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryRuntime = yield* TelemetryRuntime;
  const aiTool = yield* AiTool;
  const client = yield* FeedbackClient;

  const message = yield* legacyResolveFeedbackMessage(args);
  const agentName = Option.getOrUndefined(aiTool.name);
  const projectRef = yield* legacyResolveFeedbackProjectRef(cliConfig.workdir, cliConfig.projectId);

  const sending = yield* output.task("Sending feedback...");

  const { deleteToken } = yield* client
    .submit({
      message,
      projectRef: Option.getOrUndefined(projectRef),
      context: {
        cliVersion: telemetryRuntime.cliVersion,
        userAgent: cliConfig.userAgent,
        os: runtimeInfo.platform,
        arch: runtimeInfo.arch,
        isAgent: agentName !== undefined,
        agentName,
      },
    })
    .pipe(Effect.tapError(() => sending.fail()));

  yield* sending.clear();

  if (output.format !== "text") {
    yield* output.success("Thanks for the feedback!", { delete_token: deleteToken });
    return;
  }
  yield* output.success("Thanks for the feedback!");
  yield* output.info(`To delete this feedback later, run: supabase feedback delete ${deleteToken}`);
});
