import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

export class LegacySnippetsListNetworkError extends Data.TaggedError(
  "LegacySnippetsListNetworkError",
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

export class LegacySnippetsListUnexpectedStatusError extends Data.TaggedError(
  "LegacySnippetsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

// Mirrors Go's `utils.ErrEnvNotSupported` ("--output env is not supported"),
// returned from `list.Run` when `OutputFormat.Value == OutputEnv`.
export class LegacySnippetsEnvNotSupportedError extends Data.TaggedError(
  "LegacySnippetsEnvNotSupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

// Wraps `uuid.Parse` failure in `download.Run`; message preserves Go's
// `invalid snippet ID: <cause>` prefix so callers see the same string.
export class LegacySnippetsInvalidIdError extends Data.TaggedError("LegacySnippetsInvalidIdError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class LegacySnippetsDownloadNetworkError extends Data.TaggedError(
  "LegacySnippetsDownloadNetworkError",
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

export class LegacySnippetsDownloadUnexpectedStatusError extends Data.TaggedError(
  "LegacySnippetsDownloadUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // A 404 from `GET /v1/snippets/{id}` means the user-supplied snippet id did
    // not match any snippet — user input, not an API failure.
    if (this.status === 404) {
      return { ...actionability.invalidInput, fingerprint_suffix: "not_found" };
    }
    return statusCodeActionability(this.status);
  }
}
