import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/** A branch name was given but no linked parent project could be resolved to search for it. */
export class LinkBranchNotLinkedError extends Data.TaggedError("LinkBranchNotLinkedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.projectNotLinked;
  }
}

/** A linked-parent candidate (env, cache or `project-ref` file) exists but none is ref-shaped. */
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

/** The branch has no `project_ref` yet (e.g. `CREATING_PROJECT`), so the lookup stops there. */
export class LinkBranchNotReadyError extends Data.TaggedError("LinkBranchNotReadyError")<{
  readonly branch: string;
  readonly status: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "branch_not_ready" };
  }
}

/** Transport or response-decode failure while listing branches or fetching one by UUID. */
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

/** `GET /v1/projects/{ref}/branches` or `GET /v1/branches/{id}` returned a non-200 status. */
export class LinkBranchListStatusError extends Data.TaggedError("LinkBranchListStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}
