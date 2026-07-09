import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  CliErrorCategory,
  CliErrorKind,
  CliSuggestionType,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

/** Transport (or body-decode) failure while fetching `GET /v1/projects/{ref}`. */
export class LegacyLinkProjectStatusNetworkError extends Data.TaggedError(
  "LegacyLinkProjectStatusNetworkError",
)<{
  readonly message: string;
  /**
   * Set when the failure was the generated client rejecting the response body
   * (`SchemaError` / `HttpBodyError`) rather than a transport failure — an API
   * response problem instead of a network one.
   */
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/**
 * `GET /v1/projects/{ref}` returned a non-200, non-404 status. Byte-matches Go's
 * `"Unexpected error retrieving remote project status: " + body` (`link.go:252`).
 */
export class LegacyLinkProjectStatusError extends Data.TaggedError("LegacyLinkProjectStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

/**
 * The remote project is paused (`status == INACTIVE`). Message `"project is paused"`
 * with the dashboard unpause suggestion attached, mirroring Go's `errProjectPaused`
 * + `utils.CmdSuggestion` (`link.go:256-258`).
 */
export class LegacyProjectPausedError extends Data.TaggedError("LegacyProjectPausedError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The rendered remediation is "unpause it from the Supabase dashboard" —
    // remote project state, not local config and not an entitlement failure.
    return {
      error_kind: CliErrorKind.UserActionable,
      error_category: CliErrorCategory.ProjectPaused,
      has_suggestion: true,
      suggestion_type: CliSuggestionType.OpenDashboard,
    };
  }
}

/** Transport failure while fetching `GET /v1/projects/{ref}/api-keys`. */
export class LegacyLinkApiKeysNetworkError extends Data.TaggedError(
  "LegacyLinkApiKeysNetworkError",
)<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/**
 * `GET /v1/projects/{ref}/api-keys` returned a non-200 status. Byte-matches Go's
 * `ErrAuthToken` (`"Authorization failed for the access token and project ref pair"`)
 * formatted with the response body (`client.go:78`).
 */
export class LegacyLinkAuthTokenError extends Data.TaggedError("LegacyLinkAuthTokenError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The shared mapper wraps any non-200 in this tag; only a 401 is an auth
    // failure the user fixes by re-logging in.
    return statusCodeActionability(this.status);
  }
}

/**
 * The api-keys response contained no usable anon/service-role key. Byte-matches
 * Go's `errMissingKey` (`"Anon key not found."`, `client.go:15`).
 */
export class LegacyLinkMissingKeyError extends Data.TaggedError("LegacyLinkMissingKeyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
