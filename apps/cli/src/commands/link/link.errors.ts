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
   * Set when the failure was the generated client rejecting the response body (`SchemaError`)
   * rather than a transport failure.
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
 * `GET /v1/projects/{ref}` returned a non-200, non-404 status; the message is
 * `"Unexpected error retrieving remote project status: " + body`.
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
 * The remote project is paused (`status == INACTIVE`). Message `"project is paused"` with the
 * dashboard unpause suggestion attached.
 */
export class ProjectPausedError extends Data.TaggedError("ProjectPausedError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Remote project state, not local config or an entitlement failure.
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
 * `GET /v1/projects/{ref}/api-keys` returned a non-200 status; the message is
 * `"Authorization failed for the access token and project ref pair"` plus the response body.
 */
export class LinkAuthTokenError extends Data.TaggedError("LinkAuthTokenError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // 401 maps to re-login, 404 to an invalid user-supplied ref, everything else to API status.
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/**
 * The api-keys response contained no usable anon/service-role key; the message is
 * `"Anon key not found."`.
 */
export class LinkMissingKeyError extends Data.TaggedError("LinkMissingKeyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

/** Both the `[ref-or-branch]` positional argument and `--project-ref` were given (non-empty). */
export class LinkRefArgConflictError extends Data.TaggedError("LinkRefArgConflictError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * A non-ref-shaped value was given (treated as a branch name) but no linked parent project
 * could be resolved to search for that branch — none of `SUPABASE_PROJECT_ID`,
 * `supabase/.temp/linked-project.json`, or `supabase/.temp/project-ref` yielded a candidate.
 */
export class LinkBranchNotLinkedError extends Data.TaggedError("LinkBranchNotLinkedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.projectNotLinked;
  }
}

/**
 * A parent-project candidate exists (`SUPABASE_PROJECT_ID`, `supabase/.temp/linked-project.json`,
 * or `supabase/.temp/project-ref`) but none of them is ref-shaped — corrupt or stale linked state.
 */
export class LinkParentRefInvalidError extends Data.TaggedError("LinkParentRefInvalidError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.relinkProject;
  }
}

/** No branch with the given name/UUID exists on the resolved parent project. */
export class LinkBranchNotFoundError extends Data.TaggedError("LinkBranchNotFoundError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * The resolved branch has no `project_ref` yet (e.g. `status: CREATING_PROJECT`). Guards
 * against silently falling through to an unrelated ref elsewhere in the resolver chain.
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
