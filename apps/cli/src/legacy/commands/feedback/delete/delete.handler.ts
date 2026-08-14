import { Effect, Option } from "effect";
import { FeedbackClient } from "../../../../shared/feedback/feedback-client.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
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
  const cliConfig = yield* LegacyCliConfig;
  const client = yield* FeedbackClient;

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

  const looking = yield* output.task("Looking up feedback...");
  const preview = yield* client
    .preview(token, projectRef)
    .pipe(Effect.tapError(() => looking.fail()));
  yield* looking.clear();

  if (Option.isNone(preview)) {
    return yield* Effect.fail(
      new LegacyFeedbackNotFoundError({ message: LEGACY_FEEDBACK_NOT_FOUND_MESSAGE }),
    );
  }
  const feedbackText = preview.value;

  if (output.format === "text") {
    yield* output.info(`Found feedback: "${feedbackText}"`);
  }

  // `--yes`/`SUPABASE_YES` auto-confirms; otherwise prompt. In non-interactive
  // contexts (json/stream-json, or piped text mode) the prompt fails loudly
  // with NonInteractiveError rather than silently deleting — pass --yes there.
  const yes = yield* legacyResolveYes;
  if (!yes) {
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
    .delete(token, projectRef)
    .pipe(Effect.tapError(() => deleting.fail()));
  yield* deleting.clear();

  // The preview matched but the delete didn't: the row disappeared in between.
  if (!deleted) {
    return yield* Effect.fail(
      new LegacyFeedbackNotFoundError({ message: LEGACY_FEEDBACK_NOT_FOUND_MESSAGE }),
    );
  }

  if (output.format !== "text") {
    yield* output.success("Feedback deleted.", { feedback: feedbackText });
    return;
  }
  yield* output.success("Feedback deleted.");
});
