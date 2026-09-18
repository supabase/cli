import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/**
 * Message used for declined-confirmation cancellation errors. The text
 * `Output.fail` renderer matches this exact string (after
 * `normalizeCliError`'s trimming) to suppress the `--debug` hint, since
 * declining a prompt is a user decision, not something worth troubleshooting.
 *
 * The match is exact, not prefix/substring — widen it if a wrapped
 * cancellation message (e.g. `"...: context canceled"`) ever needs the same
 * treatment.
 */
export const CONTEXT_CANCELED_MESSAGE = "context canceled";

export class NonInteractiveError extends Data.TaggedError("NonInteractiveError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return `${this.detail}\n  Suggestion: ${this.suggestion}`;
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
