import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  CliErrorCategory,
  CliErrorKind,
  CliSuggestionType,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/** Transport (or response-decode) failure while fetching `GET /v1/projects/{ref}`. */
export class LinkProjectStatusNetworkError extends Data.TaggedError(
  "LinkProjectStatusNetworkError",
)<{
  readonly message: string;
  /**
   * Set when the failure was the generated client rejecting the response body
   * (`SchemaError`) rather than a transport failure — an API response problem
   * instead of a network one.
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
export class LinkProjectStatusError extends Data.TaggedError("LinkProjectStatusError")<{
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
 * with the dashboard unpause suggestion attached, mirroring `errProjectPaused`
 * + `utils.CmdSuggestion`.
 */
export class ProjectPausedError extends Data.TaggedError("ProjectPausedError")<{
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
export class LinkApiKeysNetworkError extends Data.TaggedError("LinkApiKeysNetworkError")<{
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
export class LinkAuthTokenError extends Data.TaggedError("LinkAuthTokenError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The shared mapper wraps any non-200 in this tag; the status policy maps
    // 401 → re-login, 404 → user-supplied ref not found, everything else →
    // API status.
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/**
 * The api-keys response contained no usable anon/service-role key. Byte-matches
 * `errMissingKey` (`"Anon key not found."`, `client.go:15`).
 */
export class LinkMissingKeyError extends Data.TaggedError("LinkMissingKeyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

/**
 * Both the `[ref-or-branch]` positional argument and `--project-ref` were given
 * (non-empty). TS-only surface (CLI-2167, no Go counterpart).
 */
export class LinkRefArgConflictError extends Data.TaggedError("LinkRefArgConflictError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * A non-ref-shaped value was given (treated as a branch name) but no linked
 * parent project could be resolved to search for that branch — none of
 * `SUPABASE_PROJECT_ID`, `supabase/.temp/linked-project.json`, or
 * `supabase/.temp/project-ref` yielded a candidate at all. TS-only surface
 * (CLI-2167, no Go counterpart).
 */
export class LinkBranchNotLinkedError extends Data.TaggedError("LinkBranchNotLinkedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.projectNotLinked;
  }
}

/**
 * A parent-project candidate exists (`SUPABASE_PROJECT_ID`,
 * `supabase/.temp/linked-project.json`, or `supabase/.temp/project-ref`) but
 * none of them is ref-shaped — corrupt or stale linked state. TS-only surface
 * (CLI-2167, no Go counterpart).
 */
export class LinkParentRefInvalidError extends Data.TaggedError("LinkParentRefInvalidError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.relinkProject;
  }
}

/**
 * No branch with the given name/UUID exists on the resolved parent project.
 * TS-only surface (CLI-2167, no Go counterpart).
 */
export class LinkBranchNotFoundError extends Data.TaggedError("LinkBranchNotFoundError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * The resolved branch has no `project_ref` yet (e.g. `status: CREATING_PROJECT`).
 * Guards against silently falling through to an unrelated ref elsewhere in the
 * resolver chain. TS-only surface (CLI-2167, no Go counterpart).
 */
export class LinkBranchNotReadyError extends Data.TaggedError("LinkBranchNotReadyError")<{
  readonly branch: string;
  readonly status: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "branch_not_ready" };
  }
}

/** Transport (or response-decode) failure while listing branches for a branch-name lookup. */
export class LinkBranchListNetworkError extends Data.TaggedError("LinkBranchListNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** `GET /v1/projects/{ref}/branches` returned a non-200 status during a branch-name lookup. */
export class LinkBranchListStatusError extends Data.TaggedError("LinkBranchListStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}
