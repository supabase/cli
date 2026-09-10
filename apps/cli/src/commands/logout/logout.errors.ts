import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * Raised when the user declines the logout confirmation prompt. Constructing it with
 * `CONTEXT_CANCELED_MESSAGE` (`shared/output/errors.ts`) is what makes `Output.fail` render
 * `context canceled` on stderr without the `--debug` suggestion.
 */
export class LogoutCancelledError extends Data.TaggedError("LogoutCancelledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
