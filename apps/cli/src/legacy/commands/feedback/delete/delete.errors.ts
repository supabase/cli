import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export const LEGACY_FEEDBACK_INVALID_TOKEN_MESSAGE =
  "The token must be a UUID (e.g. 123e4567-e89b-12d3-a456-426614174000). " +
  "It was printed when the feedback was submitted.";

export const LEGACY_FEEDBACK_NOT_FOUND_MESSAGE =
  "No feedback found for this token. It may already be deleted, the token may be wrong, " +
  "or the feedback was submitted with project/user context that isn't present — rerun " +
  "from the linked project directory (or pass --project-ref <ref>) and log in as the " +
  "account that submitted it.";

export const LEGACY_FEEDBACK_DELETE_CANCELLED_MESSAGE = "Deletion cancelled.";

/** The token argument is not a UUID (checked client-side before any request). */
export class LegacyFeedbackInvalidTokenError extends Data.TaggedError(
  "LegacyFeedbackInvalidTokenError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * The token matched no row: wrong token, already deleted, or the row was
 * submitted with a project ref and/or user id that wasn't presented (the
 * `x-feedback-project-ref` / `x-feedback-user-id` context gates). The backend
 * cannot distinguish these, so the message carries all the remediations.
 */
export class LegacyFeedbackNotFoundError extends Data.TaggedError("LegacyFeedbackNotFoundError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** The user declined the confirmation prompt. */
export class LegacyFeedbackDeleteCancelledError extends Data.TaggedError(
  "LegacyFeedbackDeleteCancelledError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
