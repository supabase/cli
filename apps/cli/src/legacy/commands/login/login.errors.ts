import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Go's `ErrMissingToken` (`apps/cli-go/cmd/login.go:16`, deleted in CLI-1970;
 * last present at commit 7b469f5b3). Go Aqua-styles the
 * `--token` / `SUPABASE_ACCESS_TOKEN` substrings, but the legacy port renders
 * styling as plain text (Go strips color on a non-TTY), so this is byte-exact.
 */
export const LEGACY_LOGIN_MISSING_TOKEN_MESSAGE =
  `Cannot use automatic login flow inside non-TTY environments. ` +
  `Please provide --token flag or set the SUPABASE_ACCESS_TOKEN environment variable.`;

/**
 * Token-path save failure — Go's `cannot save provided token: %w`
 * (`login.go:171`). Only ever constructed on the provided-token paths (`--token`
 * / `SUPABASE_ACCESS_TOKEN` / piped stdin); the browser flow saves via the raw
 * `credentials.saveAccessToken`. A malformed provided token is not fixable by
 * `supabase login`, so the remediation is to correct that input.
 */
export class LegacyLoginSaveTokenError extends Data.TaggedError("LegacyLoginSaveTokenError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authToken;
  }
}

/** Non-TTY environment with no token supplied (`login.go:34-35`). */
export class LegacyLoginMissingTokenError extends Data.TaggedError("LegacyLoginMissingTokenError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authToken;
  }
}

/**
 * A single login-session poll/parse failure. Carries the underlying message so
 * the retry notifier can print `<err>\nRetry (n/2): ` exactly like Go's
 * `newErrorCallback` (`login.go:159-166`); also the value `verifyWithRetries`
 * surfaces after the final attempt.
 */
export class LegacyLoginVerificationError extends Data.TaggedError("LegacyLoginVerificationError")<{
  readonly message: string;
  /** HTTP status of a non-200 poll response, when one was received. */
  readonly statusCode?: number;
  /** Set when the poll failed at the transport layer (connection/timeout). */
  readonly network?: boolean;
  /**
   * Set when the poll response arrived but its body could not be decoded — an
   * API response problem rather than a transport (network) one.
   */
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

/**
 * All verification retries exhausted (`login.go:214-216`). Carries the LAST
 * poll failure's discriminant so classification distinguishes "the user never
 * completed the browser flow" (the endpoint keeps returning a pending 4xx, or
 * no signal) from a genuine platform problem (5xx / transport). See the Go
 * poll protocol: `pollForAccessToken` treats every non-200 as a retryable
 * error (`login.go:132-157`, `pkg/fetcher/http.go:102-113`).
 */
export class LegacyLoginFailedError extends Data.TaggedError("LegacyLoginFailedError")<{
  readonly message: string;
  readonly statusCode?: number;
  readonly network?: boolean;
  /**
   * Set when the last poll response arrived but its body could not be decoded —
   * an API response problem rather than a transport (network) one or an
   * incomplete browser flow.
   */
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.decode === true) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
    }
    if (this.network === true) {
      return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
    }
    if (this.statusCode !== undefined && this.statusCode >= 500) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_status" };
    }
    return actionability.authLogin;
  }
}

/** ECDH / AES-GCM decryption failure — Go's `cannot decrypt access token` (`login.go:47`). */
export class LegacyLoginDecryptError extends Data.TaggedError("LegacyLoginDecryptError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

/** ECDH keypair generation failure — Go's `cannot generate crypto keys` (`login.go:66`). */
export class LegacyLoginCryptoError extends Data.TaggedError("LegacyLoginCryptoError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}
