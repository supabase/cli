import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

export class SnippetsListNetworkError extends Data.TaggedError("SnippetsListNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SnippetsListUnexpectedStatusError extends Data.TaggedError(
  "SnippetsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

// Fails with "--output env is not supported" when `-o env` is requested.
export class SnippetsEnvNotSupportedError extends Data.TaggedError("SnippetsEnvNotSupportedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

// `snippets list -o toml` fails whenever a snippet carries a `description`,
// because BurntSushi refuses the `nullable.Nullable[string]`
// (`map[bool]string`) field
// ("failed to output toml: toml: cannot encode a map with non-string key type").
export class SnippetsTomlEncodeError extends Data.TaggedError("SnippetsTomlEncodeError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}

// Wraps `uuid.Parse` failure in `download.Run`; message preserves Go's
// `invalid snippet ID: <cause>` prefix so callers see the same string.
export class SnippetsInvalidIdError extends Data.TaggedError("SnippetsInvalidIdError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class SnippetsDownloadNetworkError extends Data.TaggedError("SnippetsDownloadNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SnippetsDownloadUnexpectedStatusError extends Data.TaggedError(
  "SnippetsDownloadUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}
