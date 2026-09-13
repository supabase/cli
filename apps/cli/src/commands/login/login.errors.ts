import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

export const LOGIN_MISSING_TOKEN_MESSAGE =
  `Cannot use automatic login flow inside non-TTY environments. ` +
  `Please provide --token flag or set the SUPABASE_ACCESS_TOKEN environment variable.`;

/**
 * Token-path save failure. Only ever constructed on the provided-token paths (`--token` /
 * `SUPABASE_ACCESS_TOKEN` / piped stdin); the browser flow saves via `credentials.saveAccessToken`
 * directly. A malformed provided token isn't fixable by `supabase login`, so the remediation is
 * to correct that input.
 */
export class LoginSaveTokenError extends Data.TaggedError("LoginSaveTokenError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authToken;
  }
}

/** Non-TTY environment with no token supplied. */
export class LoginMissingTokenError extends Data.TaggedError("LoginMissingTokenError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authToken;
  }
}

/**
 * A single login-session poll/parse failure. Carries the underlying message so the retry
 * notifier can print `<err>\nRetry (n/2): `; also the value `verifyWithRetries` surfaces after
 * the final attempt.
 */
export class LoginVerificationError extends Data.TaggedError("LoginVerificationError")<{
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
 * All verification retries exhausted. Carries the last poll failure's discriminant so
 * classification distinguishes "the user never completed the browser flow" (a pending 4xx, or
 * no signal) from a genuine platform problem (5xx or transport).
 */
export class LoginFailedError extends Data.TaggedError("LoginFailedError")<{
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

/** ECDH / AES-GCM decryption failure; the message is `cannot decrypt access token`. */
export class LoginDecryptError extends Data.TaggedError("LoginDecryptError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

/** ECDH keypair generation failure; the message is `cannot generate crypto keys`. */
export class LoginCryptoError extends Data.TaggedError("LoginCryptoError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}
