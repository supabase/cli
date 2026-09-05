import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export const LEGACY_FEEDBACK_EMPTY_MESSAGE =
  `Nothing to submit. Pass a message (e.g. supabase feedback add "port conflicts when running two stacks"), ` +
  `pipe it via stdin, or put -- before a message that starts with a dash.`;

/** No message from arguments, piped stdin, or an interactive prompt. */
export class LegacyFeedbackEmptyMessageError extends Data.TaggedError(
  "LegacyFeedbackEmptyMessageError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The message text itself is the remediation: pass a message argument,
    // pipe stdin, or use the `--` sentinel.
    return actionability.provideFlags;
  }
}

/** The server-enforced feedback length cap, mirrored client-side. */
export const LEGACY_FEEDBACK_MESSAGE_LIMIT = 1000;

/**
 * Bytes of piped stdin read before bailing out as over-limit. Sixteen times
 * the limit's worst-case UTF-8 size (4 bytes per code point), so anything a
 * plausible message produces — including generous whitespace padding — stays
 * under it, while `cat huge.log | supabase feedback add` fails fast instead
 * of buffering the whole pipe.
 */
export const LEGACY_FEEDBACK_PIPE_CAP_BYTES = 64 * 1024;

export const LEGACY_FEEDBACK_PIPE_TOO_LONG_MESSAGE =
  `Piped feedback exceeds the ${LEGACY_FEEDBACK_MESSAGE_LIMIT}-character limit. ` +
  `Please shorten it and try again.`;

export function legacyFeedbackTooLongMessage(length: number): string {
  return (
    `Feedback message is ${length} characters; ` +
    `the limit is ${LEGACY_FEEDBACK_MESSAGE_LIMIT}. Please shorten it and try again.`
  );
}

/**
 * Message over the documented server-side limit — checked client-side so a
 * user mistake fails fast with a friendly message instead of surfacing as a
 * PostgREST error classified as a backend failure.
 */
export class LegacyFeedbackMessageTooLongError extends Data.TaggedError(
  "LegacyFeedbackMessageTooLongError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
