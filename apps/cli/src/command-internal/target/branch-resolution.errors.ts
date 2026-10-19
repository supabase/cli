import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

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
