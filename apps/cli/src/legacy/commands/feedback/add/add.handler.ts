import { Effect, Option, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { FeedbackClient } from "../../../../shared/feedback/feedback-client.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { LegacyAgentFlag, LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { AiTool } from "../../../../shared/telemetry/ai-tool.service.ts";
import { TelemetryRuntime } from "../../../../shared/telemetry/runtime.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { legacyResolveAgentMode } from "../../../shared/legacy-agent-mode.ts";
import { encodeGoJson } from "../../../shared/legacy-go-output.encoders.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveFeedbackProjectRef } from "../feedback-project-ref.ts";
import { legacySettleFeedbackTask } from "../feedback-task.ts";
import type { LegacyFeedbackAddArgs } from "./add.command.ts";
import {
  LEGACY_FEEDBACK_EMPTY_MESSAGE,
  LEGACY_FEEDBACK_MESSAGE_LIMIT,
  LEGACY_FEEDBACK_PIPE_CAP_BYTES,
  LEGACY_FEEDBACK_PIPE_TOO_LONG_MESSAGE,
  LegacyFeedbackEmptyMessageError,
  LegacyFeedbackMessageTooLongError,
  legacyFeedbackTooLongMessage,
} from "./add.errors.ts";

// Collects piped stdin in constant memory, bailing out as over-limit once the
// byte cap is crossed — the documented character limit makes anything past the
// cap over-limit without buffering the rest of the pipe. Read errors degrade
// to "no piped input", the same as `readPipedText`.
const legacyReadCappedPipedText = (pipe: Stream.Stream<Uint8Array, PlatformError>) =>
  Effect.gen(function* () {
    const parts: Array<Uint8Array> = [];
    let total = 0;
    yield* pipe.pipe(
      Stream.runForEachWhile((chunk) =>
        Effect.sync(() => {
          parts.push(chunk);
          total += chunk.length;
          return total <= LEGACY_FEEDBACK_PIPE_CAP_BYTES;
        }),
      ),
      Effect.catchTag("PlatformError", () => Effect.succeed(undefined)),
    );
    if (total > LEGACY_FEEDBACK_PIPE_CAP_BYTES) {
      return yield* Effect.fail(
        new LegacyFeedbackMessageTooLongError({ message: LEGACY_FEEDBACK_PIPE_TOO_LONG_MESSAGE }),
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
// interactive: false) → LegacyFeedbackEmptyMessageError. Whitespace-only
// input falls through to the next source.
const legacyResolveFeedbackMessage = Effect.fnUntraced(function* (args: LegacyFeedbackAddArgs) {
  const fromArgs = args.message.join(" ").trim();
  if (fromArgs.length > 0) return fromArgs;

  const stdin = yield* Stdin;
  if (!stdin.isTTY) {
    const piped = yield* legacyReadCappedPipedText(stdin.pipedBytesStream);
    if (Option.isSome(piped)) return piped.value;
  }

  const output = yield* Output;
  // `output.interactive` is stdout-derived; the prompt reads stdin. Both must
  // be TTYs — whitespace-only piped stdin with a TTY stdout would otherwise
  // open a prompt against exhausted non-TTY stdin instead of failing below.
  if (stdin.isTTY && output.interactive) {
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
  const goOutputFlag = yield* LegacyOutputFlag;
  const cliSettings = yield* LegacyCliSettings;
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryRuntime = yield* TelemetryRuntime;
  const aiTool = yield* AiTool;
  const client = yield* FeedbackClient;
  const telemetryState = yield* LegacyTelemetryState;

  // Persist the telemetry state file (`~/.supabase/telemetry.json`) whether
  // the submission succeeds or fails — the same PersistentPostRun-shaped
  // finalizer every legacy command runs.
  yield* Effect.gen(function* () {
    const message = yield* legacyResolveFeedbackMessage(args);
    // The backend enforces the 1000-character limit; mirroring it client-side
    // keeps a user mistake from surfacing as a cryptic PostgREST error
    // classified as a backend failure (same reason `feedback delete`
    // pre-validates the token's UUID shape). Counted in code points to match
    // Postgres `char_length`, so the client never rejects a message the
    // server would accept.
    const messageLength = [...message].length;
    if (messageLength > LEGACY_FEEDBACK_MESSAGE_LIMIT) {
      return yield* Effect.fail(
        new LegacyFeedbackMessageTooLongError({
          message: legacyFeedbackTooLongMessage(messageLength),
        }),
      );
    }
    // `--agent yes|no` overrides detection (`auto`), same as root's output
    // selection and `db query`. When the override says "not an agent", the
    // detected tool name is suppressed too so the payload cannot contradict
    // itself; `--agent yes` without a detected tool sends no name.
    const agentFlag = yield* LegacyAgentFlag;
    const isAgent = legacyResolveAgentMode(agentFlag, aiTool.name);
    const agentName = isAgent ? Option.getOrUndefined(aiTool.name) : undefined;
    const projectRef = yield* legacyResolveFeedbackProjectRef(
      cliSettings.workdir,
      cliSettings.projectId,
    );

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
      .pipe(legacySettleFeedbackTask(sending));

    // `-o json` takes priority over `--output-format` (legacy shell invariant 6):
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
