import { Effect, Option, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { FeedbackClient } from "../../../shared/feedback/feedback-client.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { AgentFlag, OutputFlag } from "../../../command-internal/global-flags.ts";
import { AiTool } from "../../../shared/telemetry/ai-tool.service.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { resolveAgentMode } from "../../../command-internal/agent-mode.ts";
import { encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveFeedbackProjectRef } from "../feedback-project-ref.ts";
import { settleFeedbackTask } from "../feedback-task.ts";
import type { FeedbackAddArgs } from "./add.command.ts";
import {
  FEEDBACK_EMPTY_MESSAGE,
  FEEDBACK_MESSAGE_LIMIT,
  FEEDBACK_PIPE_CAP_BYTES,
  FEEDBACK_PIPE_TOO_LONG_MESSAGE,
  FeedbackEmptyMessageError,
  FeedbackMessageTooLongError,
  feedbackTooLongMessage,
} from "./add.errors.ts";

// Collects piped stdin in constant memory, bailing out as over-limit once the
// byte cap is crossed — the documented character limit makes anything past the
// cap over-limit without buffering the rest of the pipe. Read errors degrade
// to "no piped input", the same as `readPipedText` — including errors that
// arrive after some chunks were already buffered: the prefix is discarded
// rather than submitted as if it were the whole message.
const readCappedPipedText = (pipe: Stream.Stream<Uint8Array, PlatformError>) =>
  Effect.gen(function* () {
    const parts: Array<Uint8Array> = [];
    let total = 0;
    let readFailed = false;
    yield* pipe.pipe(
      Stream.runForEachWhile((chunk) =>
        Effect.sync(() => {
          parts.push(chunk);
          total += chunk.length;
          return total <= FEEDBACK_PIPE_CAP_BYTES;
        }),
      ),
      Effect.catchTag("PlatformError", () =>
        Effect.sync(() => {
          readFailed = true;
        }),
      ),
    );
    if (readFailed) return Option.none<string>();
    if (total > FEEDBACK_PIPE_CAP_BYTES) {
      return yield* Effect.fail(
        new FeedbackMessageTooLongError({ message: FEEDBACK_PIPE_TOO_LONG_MESSAGE }),
      );
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const text = new TextDecoder().decode(bytes).trim();
    return text.length > 0 ? Option.some(text) : Option.none<string>();
  });

// Resolution order: positional words → piped stdin (non-TTY) → interactive
// prompt (TTY, text mode only — json/stream-json layers report
// interactive: false) → FeedbackEmptyMessageError. Whitespace-only
// input falls through to the next source.
const resolveFeedbackMessage = Effect.fnUntraced(function* (args: FeedbackAddArgs) {
  const fromArgs = args.message.join(" ").trim();
  if (fromArgs.length > 0) return fromArgs;

  const stdin = yield* Stdin;
  if (!stdin.isTTY) {
    const piped = yield* readCappedPipedText(stdin.pipedBytesStream);
    if (Option.isSome(piped)) return piped.value;
  }

  const output = yield* Output;
  const goFmt = Option.getOrUndefined(yield* OutputFlag);
  // `output.interactive` is stdout-derived; the prompt reads stdin. Both must
  // be TTYs — whitespace-only piped stdin with a TTY stdout would otherwise
  // open a prompt against exhausted non-TTY stdin instead of failing below.
  // `-o json` leaves `output.format === "text"` (it is independent of
  // `--output-format`), so it is gated explicitly: the clack prompt would
  // write ANSI and prompt text to stdout ahead of the machine payload.
  if (stdin.isTTY && output.interactive && goFmt !== "json") {
    const typed = yield* output.promptText("What's on your mind?", {
      validate: (value) =>
        value.trim().length === 0 ? "Feedback message cannot be empty." : undefined,
    });
    return typed.trim();
  }

  return yield* Effect.fail(new FeedbackEmptyMessageError({ message: FEEDBACK_EMPTY_MESSAGE }));
});

export const feedbackAdd = Effect.fn("feedback.add")(function* (args: FeedbackAddArgs) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const cliSettings = yield* CommandSettings;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryRuntime = yield* TelemetryRuntime;
  const aiTool = yield* AiTool;
  const client = yield* FeedbackClient;
  const telemetryState = yield* TelemetryState;

  // Persist the telemetry state file (`~/.supabase/telemetry.json`) whether
  // the submission succeeds or fails — the same PersistentPostRun-shaped
  // finalizer every command runs.
  yield* Effect.gen(function* () {
    const message = yield* resolveFeedbackMessage(args);
    // The backend enforces the 1000-character limit; mirroring it client-side
    // keeps a user mistake from surfacing as a cryptic PostgREST error
    // classified as a backend failure (same reason `feedback delete`
    // pre-validates the token's UUID shape). Counted in code points to match
    // Postgres `char_length`, so the client never rejects a message the
    // server would accept.
    const messageLength = [...message].length;
    if (messageLength > FEEDBACK_MESSAGE_LIMIT) {
      return yield* Effect.fail(
        new FeedbackMessageTooLongError({
          message: feedbackTooLongMessage(messageLength),
        }),
      );
    }
    // `--agent yes|no` overrides detection (`auto`), same as root's output
    // selection and `db query`. When the override says "not an agent", the
    // detected tool name is suppressed too so the payload cannot contradict
    // itself; `--agent yes` without a detected tool sends no name.
    const agentFlag = yield* AgentFlag;
    const isAgent = resolveAgentMode(agentFlag, aiTool.name);
    const agentName = isAgent ? Option.getOrUndefined(aiTool.name) : undefined;
    const projectRef = yield* resolveFeedbackProjectRef(cliSettings.workdir, cliSettings.projectId);

    const sending = yield* output.task("Sending feedback...");

    const { deleteToken } = yield* client
      .submit({
        message,
        projectRef: Option.getOrUndefined(projectRef),
        // Gotrue user UUID stamped into ~/.supabase/telemetry.json at login (ADR
        // 0013). A synchronous in-memory read — best-effort attribution with no
        // auth/API/network dependency, so feedback keeps working logged-out
        // (undefined → user_id omitted). Gated on telemetry consent: opted-out
        // users submit anonymously.
        userId:
          telemetryRuntime.consent === "granted" ? telemetryRuntime.identity.current() : undefined,
        context: {
          cliVersion: telemetryRuntime.cliVersion,
          userAgent: cliSettings.userAgent,
          os: runtimeInfo.platform,
          arch: runtimeInfo.arch,
          isAgent,
          agentName,
        },
      })
      .pipe(settleFeedbackTask(sending));

    // `-o json` takes priority over `--output-format` (CLI Agent Guide invariant 6):
    // stdout carries the machine payload only. `pretty` (or unset) falls through.
    if (Option.getOrUndefined(goOutputFlag) === "json") {
      yield* output.raw(encodeGoJson({ delete_token: deleteToken }));
      return;
    }

    if (output.format !== "text") {
      yield* output.success("Thanks for the feedback!", { delete_token: deleteToken });
      return;
    }
    yield* output.success("Thanks for the feedback!");
    yield* output.info(
      `To delete this feedback later, run: supabase feedback delete ${deleteToken}`,
    );
  }).pipe(Effect.ensuring(telemetryState.flush));
});
