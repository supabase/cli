import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Tagged errors for `db advisors`, one per failure path. Message text is an
 * established output contract.
 *
 * Connection failures reuse the shared `LegacyDbConnectError`; project-ref
 * resolution failures reuse the resolver's `LegacyProjectNotLinkedError` /
 * `LegacyInvalidProjectRefError`.
 */

/** Conflicting `db-url`/`linked`/`local` flags; message text is an established output contract. */
export class LegacyDbAdvisorsMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyDbAdvisorsMutuallyExclusiveFlagsError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--linked` PreRunE: no access token; message text and the "Run supabase
 * login first." suggestion are an established output contract.
 */
export class LegacyDbAdvisorsNotLoggedInError extends Data.TaggedError(
  "LegacyDbAdvisorsNotLoggedInError",
)<{ readonly message: string; readonly suggestion: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

/**
 * `--linked` PreRunE: the resolved access token is malformed ("Invalid access
 * token format. Must be like `sbp_0102...1920`."); message text and
 * suggestion are an established output contract. The token (env/keyring/file)
 * is validated before any project resolution or API call.
 */
export class LegacyDbAdvisorsInvalidTokenError extends Data.TaggedError(
  "LegacyDbAdvisorsInvalidTokenError",
)<{
  readonly message: string;
  readonly suggestion: string;
  /**
   * Copied from the wrapped `LegacyInvalidAccessTokenError`: an env-var token
   * (`SUPABASE_ACCESS_TOKEN`) takes precedence over stored credentials, so
   * `supabase login` cannot fix it — the remediation is to correct the env
   * var. A stored (keyring/file) token, or an unknown source, is fixable by
   * logging in again.
   */
  readonly source?: "env" | "stored";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.source === "env" ? actionability.authToken : actionability.authLogin;
  }
}

/** `failed to begin transaction: %w`; message text is an established output contract. */
export class LegacyDbAdvisorsBeginTxError extends Data.TaggedError("LegacyDbAdvisorsBeginTxError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/** `failed to prepare lint session: %w`; message text is an established output contract. */
export class LegacyDbAdvisorsSetupError extends Data.TaggedError("LegacyDbAdvisorsSetupError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/** `failed to query lints: %w`; message text is an established output contract. */
export class LegacyDbAdvisorsQueryError extends Data.TaggedError("LegacyDbAdvisorsQueryError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * `failed to fetch security advisors: %w`; message text is an established
 * output contract. A decode error folds into the same message path as a
 * transport failure — `decode` distinguishes them for actionability so a
 * 200-response decode failure classifies as an API response problem instead
 * of a network problem.
 */
export class LegacyDbAdvisorsSecurityNetworkError extends Data.TaggedError(
  "LegacyDbAdvisorsSecurityNetworkError",
)<{ readonly message: string; readonly decode?: boolean }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** `unexpected security advisors status %d: %s`; message text is an established output contract. */
export class LegacyDbAdvisorsSecurityStatusError extends Data.TaggedError(
  "LegacyDbAdvisorsSecurityStatusError",
)<{ readonly status: number; readonly body: string; readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/**
 * `failed to fetch performance advisors: %w`; message text is an established
 * output contract. A decode error folds into the same message path as a
 * transport failure — `decode` distinguishes them for actionability so a
 * 200-response decode failure classifies as an API response problem instead
 * of a network problem.
 */
export class LegacyDbAdvisorsPerformanceNetworkError extends Data.TaggedError(
  "LegacyDbAdvisorsPerformanceNetworkError",
)<{ readonly message: string; readonly decode?: boolean }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** `unexpected performance advisors status %d: %s`; message text is an established output contract. */
export class LegacyDbAdvisorsPerformanceStatusError extends Data.TaggedError(
  "LegacyDbAdvisorsPerformanceStatusError",
)<{ readonly status: number; readonly body: string; readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** `fail-on is set to %s, non-zero exit`; message text is an established output contract. */
export class LegacyDbAdvisorsFailOnError extends Data.TaggedError("LegacyDbAdvisorsFailOnError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
