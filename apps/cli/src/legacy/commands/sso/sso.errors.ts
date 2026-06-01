import { Data } from "effect";

// Shared across show / update / remove: Go's `uuid.Parse` failure.
// Message intentionally diverges from Go's verbose `failed to parse provider ID: invalid UUID …`
// — the legacy/sso port consolidates to a single short string `identity provider ID %q is not a UUID`
// that's directly user-actionable and tested in e2e.
export class LegacySsoInvalidUuidError extends Data.TaggedError("LegacySsoInvalidUuidError")<{
  readonly providerId: string;
  readonly message: string;
}> {}

// `sso list`
export class LegacySsoListNetworkError extends Data.TaggedError("LegacySsoListNetworkError")<{
  readonly message: string;
}> {}

export class LegacySsoListSamlDisabledError extends Data.TaggedError(
  "LegacySsoListSamlDisabledError",
)<{
  readonly message: string;
}> {}

export class LegacySsoListUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// `sso add`
export class LegacySsoAddNetworkError extends Data.TaggedError("LegacySsoAddNetworkError")<{
  readonly message: string;
}> {}

export class LegacySsoAddSamlDisabledError extends Data.TaggedError(
  "LegacySsoAddSamlDisabledError",
)<{
  readonly message: string;
}> {}

export class LegacySsoAddUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoAddUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacySsoAddMetadataFileError extends Data.TaggedError(
  "LegacySsoAddMetadataFileError",
)<{
  readonly message: string;
}> {}

export class LegacySsoAddAttributeMappingFileError extends Data.TaggedError(
  "LegacySsoAddAttributeMappingFileError",
)<{
  readonly message: string;
}> {}

export class LegacySsoMutexFlagError extends Data.TaggedError("LegacySsoMutexFlagError")<{
  readonly message: string;
}> {}

// Shared across add + update — metadata URL validation.
export class LegacySsoMetadataUrlInvalidError extends Data.TaggedError(
  "LegacySsoMetadataUrlInvalidError",
)<{
  readonly message: string;
}> {}

export class LegacySsoMetadataUrlNetworkError extends Data.TaggedError(
  "LegacySsoMetadataUrlNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacySsoMetadataUrlNonUtf8Error extends Data.TaggedError(
  "LegacySsoMetadataUrlNonUtf8Error",
)<{
  readonly message: string;
}> {}

// `sso show`
export class LegacySsoShowNetworkError extends Data.TaggedError("LegacySsoShowNetworkError")<{
  readonly message: string;
}> {}

export class LegacySsoShowNotFoundError extends Data.TaggedError("LegacySsoShowNotFoundError")<{
  readonly message: string;
}> {}

export class LegacySsoShowUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoShowUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacySsoShowEnvNotSupportedError extends Data.TaggedError(
  "LegacySsoShowEnvNotSupportedError",
)<{
  readonly message: string;
}> {}

// `sso update`
export class LegacySsoUpdateNetworkError extends Data.TaggedError("LegacySsoUpdateNetworkError")<{
  readonly message: string;
}> {}

export class LegacySsoUpdateNotFoundError extends Data.TaggedError("LegacySsoUpdateNotFoundError")<{
  readonly message: string;
}> {}

export class LegacySsoUpdateUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacySsoUpdateMetadataFileError extends Data.TaggedError(
  "LegacySsoUpdateMetadataFileError",
)<{
  readonly message: string;
}> {}

export class LegacySsoUpdateAttributeMappingFileError extends Data.TaggedError(
  "LegacySsoUpdateAttributeMappingFileError",
)<{
  readonly message: string;
}> {}

// `sso remove`
export class LegacySsoRemoveNetworkError extends Data.TaggedError("LegacySsoRemoveNetworkError")<{
  readonly message: string;
}> {}

export class LegacySsoRemoveNotFoundError extends Data.TaggedError("LegacySsoRemoveNotFoundError")<{
  readonly message: string;
}> {}

export class LegacySsoRemoveUnexpectedStatusError extends Data.TaggedError(
  "LegacySsoRemoveUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}
