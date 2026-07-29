import { Effect, FileSystem, Option, Path } from "effect";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { legacyReadProjectRefFile } from "../../shared/legacy-temp-paths.ts";
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

// Mirrors the soft-load half of `LegacyProjectRefResolver.resolveOptional`
// (`legacy-project-ref.layer.ts`): `SUPABASE_PROJECT_ID` (captured by
// `LegacyCliConfig`) → `<workdir>/supabase/.temp/project-ref`, the file
// `supabase link` writes. The file is read directly rather than via the full
// resolver because that layer requires `LegacyPlatformApiFactory` for its
// prompt path, and feedback must keep working when the user isn't logged in.
// A broken ref file degrades to "unlinked" instead of failing the submission.
const legacyResolveFeedbackProjectRef = Effect.fnUntraced(function* (
  workdir: string,
  fromEnv: Option.Option<string>,
) {
  if (Option.isSome(fromEnv)) return fromEnv;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* legacyReadProjectRefFile(fs, path, workdir).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
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
  const agentName = Option.getOrUndefined(aiTool.name);
  const projectRef = yield* legacyResolveFeedbackProjectRef(cliConfig.workdir, cliConfig.projectId);

  const sending = yield* output.task("Sending feedback...");

  yield* submitter
    .submit({
      message,
      projectRef: Option.getOrUndefined(projectRef),
      // Gotrue user UUID stamped into ~/.supabase/telemetry.json at login (ADR
      // 0013). A synchronous in-memory read — best-effort attribution with no
      // auth/API/network dependency, so feedback keeps working logged-out
      // (undefined → user_id null). Gated on telemetry consent: opted-out
      // users submit anonymously.
      userId:
        telemetryRuntime.consent === "granted" ? telemetryRuntime.identity.current() : undefined,
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
  yield* output.success("Thanks for the feedback!");
});
