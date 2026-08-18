import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

// ---------------------------------------------------------------------------
// HTTP-bound errors — one (Network + UnexpectedStatus) pair per error site.
// Templates match the established `errors.Errorf(...)` phrasing byte-for-byte.
// ---------------------------------------------------------------------------

export class LegacyProjectsListNetworkError extends Data.TaggedError(
  "LegacyProjectsListNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacyProjectsListUnexpectedStatusError extends Data.TaggedError(
  "LegacyProjectsListUnexpectedStatusError",
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

export class LegacyProjectsCreateNetworkError extends Data.TaggedError(
  "LegacyProjectsCreateNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacyProjectsCreateUnexpectedStatusError extends Data.TaggedError(
  "LegacyProjectsCreateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

// Interactive org list fetched by `create` when `--org-id` is omitted.
export class LegacyProjectsOrgsListNetworkError extends Data.TaggedError(
  "LegacyProjectsOrgsListNetworkError",
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

export class LegacyProjectsOrgsListUnexpectedStatusError extends Data.TaggedError(
  "LegacyProjectsOrgsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class LegacyProjectsDeleteNetworkError extends Data.TaggedError(
  "LegacyProjectsDeleteNetworkError",
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

export class LegacyProjectsDeleteUnexpectedStatusError extends Data.TaggedError(
  "LegacyProjectsDeleteUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

// "Project does not exist:<ref>" (404 branch of the delete flow).
export class LegacyProjectsDeleteNotFoundError extends Data.TaggedError(
  "LegacyProjectsDeleteNotFoundError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class LegacyProjectsApiKeysNetworkError extends Data.TaggedError(
  "LegacyProjectsApiKeysNetworkError",
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

export class LegacyProjectsApiKeysUnexpectedStatusError extends Data.TaggedError(
  "LegacyProjectsApiKeysUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

// ---------------------------------------------------------------------------
// Pure-path errors (validation, prompt-time semantics, user cancellation).
// ---------------------------------------------------------------------------

// `list` rejects `--output env` (`utils.ErrEnvNotSupported`).
export class LegacyProjectsEnvNotSupportedError extends Data.TaggedError(
  "LegacyProjectsEnvNotSupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

// Non-interactive `create` missing required params — `--org-id`,
// `--db-password`, `--region` are required, plus exactly 1 positional arg.
export class LegacyProjectsCreateMissingArgError extends Data.TaggedError(
  "LegacyProjectsCreateMissingArgError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// Interactive `create` name prompt returned blank.
export class LegacyProjectsCreateNameEmptyError extends Data.TaggedError(
  "LegacyProjectsCreateNameEmptyError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// `delete` non-interactive with no positional ref — exactly 1 positional
// arg is required on a non-TTY.
export class LegacyProjectsDeleteRefRequiredError extends Data.TaggedError(
  "LegacyProjectsDeleteRefRequiredError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// User declined the delete confirmation prompt (`errors.New(context.Canceled)`).
export class LegacyProjectsDeleteCancelledError extends Data.TaggedError(
  "LegacyProjectsDeleteCancelledError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
