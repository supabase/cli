import { Effect, Option } from "effect";
import { FeedbackClient } from "../../../shared/feedback/feedback-client.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { requireHostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { BRANCH_UUID_PATTERN } from "../../../command-internal/ref-patterns.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveFeedbackProjectRef } from "../feedback-project-ref.ts";
import { settleFeedbackTask } from "../feedback-task.ts";
import type { FeedbackDeleteArgs } from "./delete.command.ts";
import {
  FEEDBACK_INVALID_TOKEN_MESSAGE,
  FEEDBACK_NOT_FOUND_MESSAGE,
  FeedbackInvalidTokenError,
  FeedbackNotFoundError,
} from "./delete.errors.ts";

// Checked client-side so a malformed token fails with a friendly message
// instead of PostgREST's cryptic uuid-cast error (22P02) from the
// `delete_token=eq.` filter. The shared permissive UUID pattern accepts the
// same 8-4-4-4-12 hex shape the backend generates.
const UUID_PATTERN = BRANCH_UUID_PATTERN;

export const feedbackDelete = Effect.fn("feedback.delete")(function* (args: FeedbackDeleteArgs) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const cliSettings = yield* CommandSettings;
  const telemetryRuntime = yield* TelemetryRuntime;
  const client = yield* FeedbackClient;
  const telemetryState = yield* TelemetryState;

  const outputFlagFormat = Option.getOrUndefined(outputFlag);

  // Persist the telemetry state file (`~/.supabase/telemetry.json`) whether
  // the delete succeeds or fails — the telemetry-state finalizer every
  // command runs.
  yield* Effect.gen(function* () {
    if (!UUID_PATTERN.test(args.token)) {
      return yield* new FeedbackInvalidTokenError({ message: FEEDBACK_INVALID_TOKEN_MESSAGE });
    }
    // RLS compares the header lowercased; normalize so an uppercase paste works.
    const token = args.token.toLowerCase();

    // Project-ref context gate: rows submitted with a project ref only match
    // when the same ref is presented. Flag → SUPABASE_PROJECT_ID → the linked
    // ref file; extra context against a context-free row is ignored server-side,
    // so sending whatever resolves is always safe. An empty `--project-ref ""`
    // counts as unset, as in `ProjectRefResolver`; a malformed flag or env value
    // fails as invalid input instead of falling through.
    const projectRef = yield* resolveFeedbackProjectRef(
      cliSettings.workdir,
      Option.orElse(
        Option.filter(args.projectRef, (ref) => ref.length > 0),
        () => cliSettings.projectId,
      ),
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

    // The row is never read, so consent is asked before its existence is known; a wrong token
    // is reported as "not found" after the DELETE matches zero rows.
    yield* requireHostedMutationConsent({ action: "Permanently delete this feedback" });

    const deleting = yield* output.task("Deleting feedback...");
    const { deleted } = yield* client.delete(token, rowContext).pipe(settleFeedbackTask(deleting));

    // Zero rows matched: wrong token, already deleted, or a project-ref/user-id
    // context mismatch — the backend cannot tell these apart.
    if (!deleted) {
      return yield* new FeedbackNotFoundError({ message: FEEDBACK_NOT_FOUND_MESSAGE });
    }

    // `-o json` takes priority over `--output-format` (CLI Agent Guide invariant 6):
    // stdout carries the machine payload only. `pretty` (or unset) falls through.
    if (outputFlagFormat === "json") {
      yield* output.raw(encodeSortedJson({ deleted: true }));
      return;
    }

    if (output.format !== "text") {
      yield* output.success("Feedback deleted.");
      return;
    }
    yield* output.success("Feedback deleted.");
  }).pipe(Effect.ensuring(telemetryState.flush));
});
