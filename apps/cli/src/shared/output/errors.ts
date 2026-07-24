import { Data } from "effect";

/**
 * Byte-for-byte render of Go's `context.Canceled` sentinel.
 *
 * Every declined confirmation prompt in the Go CLI surfaces as a bare
 * `context.Canceled` (e.g. `errors.New(context.Canceled)` in
 * `apps/cli-go/internal/logout/logout.go:19`), and `recoverAndExit`
 * (`apps/cli-go/cmd/root.go:287-303`) deliberately skips the
 * `SuggestDebugFlag` hint for it — declining a prompt is a user decision,
 * not an error worth troubleshooting. Handlers that port those decline
 * paths construct their cancellation errors with this exact message, and
 * the text `Output.fail` renderer keys on it to suppress the `--debug`
 * hint, mirroring Go's `!errors.Is(err, context.Canceled)` guard.
 *
 * Two invariants of that renderer check:
 * - The value must stay trim-invariant: it round-trips through
 *   `normalizeCliError`'s trimming `readString` before reaching the
 *   renderer's equality check (`shared/output/normalize-error.ts`).
 * - The check is exact-match, narrower than Go's chain-walking
 *   `errors.Is`: a future producer surfacing a WRAPPED cancellation
 *   (`"...: context canceled"`) through `Output.fail` would keep the hint
 *   where Go suppresses it — no such producer exists today (mid-flight
 *   Ctrl-C takes the interrupt/exit-130 path and never reaches
 *   `Output.fail`), but widen the check if one ever appears.
 */
export const CONTEXT_CANCELED_MESSAGE = "context canceled";

export class NonInteractiveError extends Data.TaggedError("NonInteractiveError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  override get message() {
    return `${this.detail}\n  Suggestion: ${this.suggestion}`;
  }
}
