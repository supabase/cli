import { Data } from "effect";

/**
 * Go's `ErrMissingToken` (`apps/cli-go/cmd/login.go:16`). Go Aqua-styles the
 * `--token` / `SUPABASE_ACCESS_TOKEN` substrings, but the legacy port renders
 * styling as plain text (Go strips color on a non-TTY), so this is byte-exact.
 */
export const LEGACY_LOGIN_MISSING_TOKEN_MESSAGE =
  `Cannot use automatic login flow inside non-TTY environments. ` +
  `Please provide --token flag or set the SUPABASE_ACCESS_TOKEN environment variable.`;

/** Token-path save failure — Go's `cannot save provided token: %w` (`login.go:171`). */
export class LegacyLoginSaveTokenError extends Data.TaggedError("LegacyLoginSaveTokenError")<{
  readonly message: string;
}> {}

/** Non-TTY environment with no token supplied (`login.go:34-35`). */
export class LegacyLoginMissingTokenError extends Data.TaggedError("LegacyLoginMissingTokenError")<{
  readonly message: string;
}> {}

/**
 * A single login-session poll/parse failure. Carries the underlying message so
 * the retry notifier can print `<err>\nRetry (n/2): ` exactly like Go's
 * `newErrorCallback` (`login.go:159-166`); also the value `verifyWithRetries`
 * surfaces after the final attempt.
 */
export class LegacyLoginVerificationError extends Data.TaggedError("LegacyLoginVerificationError")<{
  readonly message: string;
}> {}

/** All verification retries exhausted (`login.go:214-216`). */
export class LegacyLoginFailedError extends Data.TaggedError("LegacyLoginFailedError")<{
  readonly message: string;
}> {}

/** ECDH / AES-GCM decryption failure — Go's `cannot decrypt access token` (`login.go:47`). */
export class LegacyLoginDecryptError extends Data.TaggedError("LegacyLoginDecryptError")<{
  readonly message: string;
}> {}

/** ECDH keypair generation failure — Go's `cannot generate crypto keys` (`login.go:66`). */
export class LegacyLoginCryptoError extends Data.TaggedError("LegacyLoginCryptoError")<{
  readonly message: string;
}> {}
