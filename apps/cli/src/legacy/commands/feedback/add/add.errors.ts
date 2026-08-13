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
