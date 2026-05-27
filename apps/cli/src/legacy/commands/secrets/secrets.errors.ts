import { Data } from "effect";

// ---------------------------------------------------------------------------
// HTTP-bound errors (network + unexpected-status pairs)
// ---------------------------------------------------------------------------

export class LegacySecretsListNetworkError extends Data.TaggedError(
  "LegacySecretsListNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacySecretsListUnexpectedStatusError extends Data.TaggedError(
  "LegacySecretsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacySecretsSetNetworkError extends Data.TaggedError("LegacySecretsSetNetworkError")<{
  readonly message: string;
}> {}

export class LegacySecretsSetUnexpectedStatusError extends Data.TaggedError(
  "LegacySecretsSetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacySecretsUnsetNetworkError extends Data.TaggedError(
  "LegacySecretsUnsetNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacySecretsUnsetUnexpectedStatusError extends Data.TaggedError(
  "LegacySecretsUnsetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Pure-path errors (validation, file I/O, user cancellation)
// ---------------------------------------------------------------------------

export class LegacySecretsEnvFileOpenError extends Data.TaggedError(
  "LegacySecretsEnvFileOpenError",
)<{
  readonly message: string;
}> {}

export class LegacySecretsEnvFileParseError extends Data.TaggedError(
  "LegacySecretsEnvFileParseError",
)<{
  readonly message: string;
}> {}

export class LegacyInvalidSecretPairError extends Data.TaggedError("LegacyInvalidSecretPairError")<{
  readonly pair: string;
  readonly message: string;
}> {}

export class LegacySecretsNoArgumentsError extends Data.TaggedError(
  "LegacySecretsNoArgumentsError",
)<{
  readonly message: string;
}> {}

export class LegacySecretsEnvNotSupportedError extends Data.TaggedError(
  "LegacySecretsEnvNotSupportedError",
)<{
  readonly message: string;
}> {}

export class LegacySecretsUnsetCancelledError extends Data.TaggedError(
  "LegacySecretsUnsetCancelledError",
)<{
  readonly message: string;
}> {}

export class LegacySecretsConfigParseError extends Data.TaggedError(
  "LegacySecretsConfigParseError",
)<{
  readonly message: string;
}> {}
