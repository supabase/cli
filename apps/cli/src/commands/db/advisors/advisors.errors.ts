import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Tagged errors for `db advisors`, one per failure path. Message text is an
 * established output contract.
 *
 * Connection failures reuse the shared `DbConnectError`; project-ref
 * resolution failures reuse the resolver's `ProjectRefNotLinkedError` /
 * `InvalidProjectRefError`.
 */

/** Conflicting `db-url`/`linked`/`local` flags; message text is an established output contract. */
export class DbAdvisorsMutuallyExclusiveFlagsError extends Data.TaggedError(
  "DbAdvisorsMutuallyExclusiveFlagsError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--linked` PreRunE: no access token; message text and the "Run supabase
 * login first." suggestion are an established output contract.
 */
export class DbAdvisorsNotLoggedInError extends Data.TaggedError("DbAdvisorsNotLoggedInError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
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
export class DbAdvisorsInvalidTokenError extends Data.TaggedError("DbAdvisorsInvalidTokenError")<{
  readonly message: string;
  readonly suggestion: string;
  /**
   * An env-var token (`SUPABASE_ACCESS_TOKEN`) takes precedence over stored credentials, so
   * `supabase login` cannot fix it — the remediation is to correct the env var. A stored
   * (keyring/file) token, or an unknown source, is fixable by logging in again.
   */
  readonly source?: "env" | "stored";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.source === "env" ? actionability.authToken : actionability.authLogin;
  }
}

/** `failed to begin transaction: %w`; message text is an established output contract. */
export class DbAdvisorsBeginTxError extends Data.TaggedError("DbAdvisorsBeginTxError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/** `failed to prepare lint session: %w`; message text is an established output contract. */
export class DbAdvisorsSetupError extends Data.TaggedError("DbAdvisorsSetupError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/** `failed to query lints: %w`; message text is an established output contract. */
export class DbAdvisorsQueryError extends Data.TaggedError("DbAdvisorsQueryError")<{
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
export class DbAdvisorsSecurityNetworkError extends Data.TaggedError(
  "DbAdvisorsSecurityNetworkError",
)<{ readonly message: string; readonly decode?: boolean }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** `unexpected security advisors status %d: %s`; message text is an established output contract. */
export class DbAdvisorsSecurityStatusError extends Data.TaggedError(
  "DbAdvisorsSecurityStatusError",
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
export class DbAdvisorsPerformanceNetworkError extends Data.TaggedError(
  "DbAdvisorsPerformanceNetworkError",
)<{ readonly message: string; readonly decode?: boolean }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** `unexpected performance advisors status %d: %s`; message text is an established output contract. */
export class DbAdvisorsPerformanceStatusError extends Data.TaggedError(
  "DbAdvisorsPerformanceStatusError",
)<{ readonly status: number; readonly body: string; readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** `fail-on is set to %s, non-zero exit`; message text is an established output contract. */
export class DbAdvisorsFailOnError extends Data.TaggedError("DbAdvisorsFailOnError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
