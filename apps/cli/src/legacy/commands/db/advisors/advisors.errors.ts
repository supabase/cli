import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Tagged errors for `db advisors`, one per Go failure path
 * (`internal/db/advisors/advisors.go` + the command's `PreRunE`). Messages
 * byte-match Go's `errors.Errorf` / `fmt.Errorf` text.
 *
 * Connection failures reuse the shared `LegacyDbConnectError`; project-ref
 * resolution failures reuse the resolver's `LegacyProjectNotLinkedError` /
 * `LegacyInvalidProjectRefError`.
 */

/** cobra `MarkFlagsMutuallyExclusive("db-url", "linked", "local")` (`db.go`). */
export class LegacyDbAdvisorsMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyDbAdvisorsMutuallyExclusiveFlagsError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--linked` PreRunE: no access token. Message is Go's `utils.ErrMissingToken`;
 * `suggestion` is Go's `utils.CmdSuggestion` ("Run supabase login first.").
 * See `apps/cli-go/cmd/db.go` advisors PreRunE + `internal/utils/access_token.go:18`.
 */
export class LegacyDbAdvisorsNotLoggedInError extends Data.TaggedError(
  "LegacyDbAdvisorsNotLoggedInError",
)<{ readonly message: string; readonly suggestion: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

/**
 * `--linked` PreRunE: the resolved access token is malformed. Message is Go's
 * `utils.ErrInvalidToken` ("Invalid access token format. Must be like
 * `sbp_0102...1920`."); `suggestion` is Go's `utils.CmdSuggestion`. Go's
 * `LoadAccessTokenFS` validates the token (env/keyring/file) before any project
 * resolution or API call (`internal/utils/access_token.go:17,24-33`).
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

/** `failed to begin transaction: %w` (`advisors.go:105`). */
export class LegacyDbAdvisorsBeginTxError extends Data.TaggedError("LegacyDbAdvisorsBeginTxError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/** `failed to prepare lint session: %w` (`advisors.go:115`). */
export class LegacyDbAdvisorsSetupError extends Data.TaggedError("LegacyDbAdvisorsSetupError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/** `failed to query lints: %w` (`advisors.go:120`). */
export class LegacyDbAdvisorsQueryError extends Data.TaggedError("LegacyDbAdvisorsQueryError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * `failed to fetch security advisors: %w` (`advisors.go:165`). Go folds a
 * decode error into the same message path as a transport failure — `decode`
 * distinguishes them for actionability so a 200-response decode failure
 * classifies as an API response problem instead of a network problem.
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

/** `unexpected security advisors status %d: %s` (`advisors.go:168`). */
export class LegacyDbAdvisorsSecurityStatusError extends Data.TaggedError(
  "LegacyDbAdvisorsSecurityStatusError",
)<{ readonly status: number; readonly body: string; readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/**
 * `failed to fetch performance advisors: %w` (`advisors.go:176`). Go folds a
 * decode error into the same message path as a transport failure — `decode`
 * distinguishes them for actionability so a 200-response decode failure
 * classifies as an API response problem instead of a network problem.
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

/** `unexpected performance advisors status %d: %s` (`advisors.go:179`). */
export class LegacyDbAdvisorsPerformanceStatusError extends Data.TaggedError(
  "LegacyDbAdvisorsPerformanceStatusError",
)<{ readonly status: number; readonly body: string; readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** `fail-on is set to %s, non-zero exit` (`advisors.go:257`). */
export class LegacyDbAdvisorsFailOnError extends Data.TaggedError("LegacyDbAdvisorsFailOnError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
