import { Data } from "effect";

/**
 * Raised when the user declines the logout confirmation prompt. Go returns
 * `errors.New(context.Canceled)` (`apps/cli-go/internal/logout/logout.go:18`),
 * which the root error handler renders as `context canceled` on stderr with
 * exit code 1 (`cmd/root.go:288-301` skips the debug suggestion for
 * `context.Canceled`).
 */
export class LegacyLogoutCancelledError extends Data.TaggedError("LegacyLogoutCancelledError")<{
  readonly message: string;
}> {}

export const LEGACY_LOGOUT_CANCELLED_MESSAGE = "context canceled";
