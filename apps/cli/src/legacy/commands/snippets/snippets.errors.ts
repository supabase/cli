import { Data } from "effect";

export class LegacySnippetsListNetworkError extends Data.TaggedError(
  "LegacySnippetsListNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacySnippetsListUnexpectedStatusError extends Data.TaggedError(
  "LegacySnippetsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// Mirrors Go's `utils.ErrEnvNotSupported` ("--output env is not supported"),
// returned from `list.Run` when `OutputFormat.Value == OutputEnv`.
export class LegacySnippetsEnvNotSupportedError extends Data.TaggedError(
  "LegacySnippetsEnvNotSupportedError",
)<{
  readonly message: string;
}> {}

// Wraps `uuid.Parse` failure in `download.Run`; message preserves Go's
// `invalid snippet ID: <cause>` prefix so callers see the same string.
export class LegacySnippetsInvalidIdError extends Data.TaggedError("LegacySnippetsInvalidIdError")<{
  readonly message: string;
}> {}

export class LegacySnippetsDownloadNetworkError extends Data.TaggedError(
  "LegacySnippetsDownloadNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacySnippetsDownloadUnexpectedStatusError extends Data.TaggedError(
  "LegacySnippetsDownloadUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}
