/**
 * Best-effort extraction of a human-readable message from an unknown thrown/failed
 * value — an Effect `PlatformError`, a driver error, a plain `Error`, or anything else.
 * Shared by every legacy module that wraps a raw Effect/driver failure into Go-style
 * error text (Go's own `err.Error()` equivalent), so wording stays consistent across
 * call sites instead of each one re-deriving its own fallback.
 */
export const legacyErrorMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);
