import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Raised when the user declines the logout confirmation prompt. Go returns
 * `errors.New(context.Canceled)` (`apps/cli-go/internal/logout/logout.go:19`),
 * which the root error handler renders as `context canceled` on stderr with
 * exit code 1 and no `--debug` suggestion (`cmd/root.go:287-303` skips
 * `SuggestDebugFlag` for `context.Canceled`). The TS renderer mirrors that:
 * constructing this error with `CONTEXT_CANCELED_MESSAGE`
 * (`shared/output/errors.ts`) is what makes the text `Output.fail` withhold
 * the debug hint (CLI-1973).
 */
export class LegacyLogoutCancelledError extends Data.TaggedError("LegacyLogoutCancelledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
