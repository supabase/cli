import { Effect, Option } from "effect";
import { FeedbackClient } from "../../../../shared/feedback/feedback-client.service.ts";
import { NonInteractiveError } from "../../../../shared/output/errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { LegacyOutputFlag, legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { TelemetryRuntime } from "../../../../shared/telemetry/runtime.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { encodeGoJson } from "../../../shared/legacy-go-output.encoders.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveFeedbackProjectRef } from "../feedback-project-ref.ts";
import type { LegacyFeedbackDeleteArgs } from "./delete.command.ts";
import {
  LEGACY_FEEDBACK_DELETE_CANCELLED_MESSAGE,
  LEGACY_FEEDBACK_INVALID_TOKEN_MESSAGE,
  LEGACY_FEEDBACK_NOT_FOUND_MESSAGE,
  LegacyFeedbackDeleteCancelledError,
  LegacyFeedbackInvalidTokenError,
  LegacyFeedbackNotFoundError,
} from "./delete.errors.ts";

// Checked client-side so a malformed token fails with a friendly message
// instead of PostgREST's cryptic uuid-cast error (22P02) from the
// `delete_token=eq.` filter.
const LEGACY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const legacyFeedbackDelete = Effect.fn("legacy.feedback.delete")(function* (
  args: LegacyFeedbackDeleteArgs,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryRuntime = yield* TelemetryRuntime;
  const client = yield* FeedbackClient;
  const telemetryState = yield* LegacyTelemetryState;

  const goFmt = Option.getOrUndefined(goOutputFlag);

  // Persist the telemetry state file (`~/.supabase/telemetry.json`) whether
  // the delete succeeds or fails — the same PersistentPostRun-shaped
  // finalizer every legacy command runs.
  yield* Effect.gen(function* () {
    if (!LEGACY_UUID_PATTERN.test(args.token)) {
      return yield* Effect.fail(
        new LegacyFeedbackInvalidTokenError({ message: LEGACY_FEEDBACK_INVALID_TOKEN_MESSAGE }),
      );
    }
    // RLS compares the header lowercased; normalize so an uppercase paste works.
    const token = args.token.toLowerCase();

    // Project-ref context gate: rows submitted with a project ref only match
    // when the same ref is presented. Flag → SUPABASE_PROJECT_ID → the linked
    // ref file; extra context against a context-free row is ignored server-side,
    // so sending whatever resolves is always safe.
    const projectRef = yield* legacyResolveFeedbackProjectRef(
      cliConfig.workdir,
      Option.orElse(args.projectRef, () => cliConfig.projectId),
    ).pipe(Effect.map(Option.getOrUndefined));

    // User-id context gate, same shape as the project-ref one: rows submitted
    // with a user_id only match when the same id arrives as a header. Unlike
    // the submit-side attribution this is NOT consent-gated — it is functional
    // auth context, and gating it would strand rows submitted before a consent
    // opt-out. Logged out → undefined → header omitted.
    const rowContext = {
      projectRef,
      userId: telemetryRuntime.identity.current(),
    };

    const looking = yield* output.task("Looking up feedback...");
    const preview = yield* client
      .preview(token, rowContext)
      .pipe(Effect.tapError(() => looking.fail()));
    yield* looking.clear();

    if (Option.isNone(preview)) {
      return yield* Effect.fail(
        new LegacyFeedbackNotFoundError({ message: LEGACY_FEEDBACK_NOT_FOUND_MESSAGE }),
      );
    }
    const feedbackText = preview.value;

    // Suppressed under `-o json` as well: stdout must stay payload-only, and
    // the payload already carries the feedback text.
    if (goFmt !== "json" && output.format === "text") {
      yield* output.info(`Found feedback: "${feedbackText}"`);
    }

    // `--yes`/`SUPABASE_YES` auto-confirms; otherwise prompt. Non-interactive
    // contexts fail loudly with NonInteractiveError rather than silently
    // deleting — pass --yes there. `output.interactive` is stdout-derived and
    // clack's confirm answers on a single y/n keypress from any stdin, so both
    // streams must be TTYs — otherwise `printf 'y' | feedback delete` could
    // confirm a permanent delete without --yes (same gate as the add prompt).
    const yes = yield* legacyResolveYes;
    if (!yes) {
      const stdin = yield* Stdin;
      if (!stdin.isTTY || !output.interactive) {
        return yield* Effect.fail(
          new NonInteractiveError({
            detail: "Cannot prompt for confirmation in a non-interactive context",
            suggestion: "Pass --yes to delete without confirmation",
          }),
        );
      }
      const confirmed = yield* output.promptConfirm("Permanently delete this feedback?", {
        defaultValue: false,
      });
      if (!confirmed) {
        return yield* Effect.fail(
          new LegacyFeedbackDeleteCancelledError({
            message: LEGACY_FEEDBACK_DELETE_CANCELLED_MESSAGE,
          }),
        );
      }
    }

    const deleting = yield* output.task("Deleting feedback...");
    const { deleted } = yield* client
      .delete(token, rowContext)
      .pipe(Effect.tapError(() => deleting.fail()));
    yield* deleting.clear();

    // The preview matched but the delete didn't: the row disappeared in between.
    if (!deleted) {
      return yield* Effect.fail(
        new LegacyFeedbackNotFoundError({ message: LEGACY_FEEDBACK_NOT_FOUND_MESSAGE }),
      );
    }

    // `-o json` takes priority over `--output-format` (legacy shell invariant 6):
    // stdout carries the machine payload only. `pretty` (or unset) falls through.
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson({ feedback: feedbackText }));
      return;
    }

    if (output.format !== "text") {
      yield* output.success("Feedback deleted.", { feedback: feedbackText });
      return;
    }
    yield* output.success("Feedback deleted.");
  }).pipe(Effect.ensuring(telemetryState.flush));
});
