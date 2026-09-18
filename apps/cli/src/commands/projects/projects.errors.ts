import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

export class ProjectsListNetworkError extends Data.TaggedError("ProjectsListNetworkError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class ProjectsListUnexpectedStatusError extends Data.TaggedError(
  "ProjectsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
  /**
   * Set when the failure is a 200 response whose body could not be decoded
   * (unparseable JSON / not an array) rather than a genuine non-200 status —
   * an API response problem, not a bad status code.
   */
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.decode === true) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
    }
    return statusCodeActionability(this.status);
  }
}

export class ProjectsCreateNetworkError extends Data.TaggedError("ProjectsCreateNetworkError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class ProjectsCreateUnexpectedStatusError extends Data.TaggedError(
  "ProjectsCreateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

/** Interactive org list fetched by `create` when `--org-id` is omitted. */
export class ProjectsOrgsListNetworkError extends Data.TaggedError("ProjectsOrgsListNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class ProjectsOrgsListUnexpectedStatusError extends Data.TaggedError(
  "ProjectsOrgsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class ProjectsDeleteNetworkError extends Data.TaggedError("ProjectsDeleteNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class ProjectsDeleteUnexpectedStatusError extends Data.TaggedError(
  "ProjectsDeleteUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

/** 404 branch of the delete flow. */
export class ProjectsDeleteNotFoundError extends Data.TaggedError("ProjectsDeleteNotFoundError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class ProjectsApiKeysNetworkError extends Data.TaggedError("ProjectsApiKeysNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class ProjectsApiKeysUnexpectedStatusError extends Data.TaggedError(
  "ProjectsApiKeysUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** `list` rejects `--output env`. */
export class ProjectsEnvNotSupportedError extends Data.TaggedError("ProjectsEnvNotSupportedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** Non-interactive `create` missing a required param: `--org-id`, `--db-password`, `--region`, or the name argument. */
export class ProjectsCreateMissingArgError extends Data.TaggedError(
  "ProjectsCreateMissingArgError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Interactive `create` name prompt returned blank. */
export class ProjectsCreateNameEmptyError extends Data.TaggedError("ProjectsCreateNameEmptyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `delete` non-interactive with no positional ref given on a non-TTY. */
export class ProjectsDeleteRefRequiredError extends Data.TaggedError(
  "ProjectsDeleteRefRequiredError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** User declined the delete confirmation prompt. */
export class ProjectsDeleteCancelledError extends Data.TaggedError("ProjectsDeleteCancelledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
