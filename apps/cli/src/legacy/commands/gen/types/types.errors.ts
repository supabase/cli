import { Data } from "effect";

export class LegacyGenTypesNetworkError extends Data.TaggedError("LegacyGenTypesNetworkError")<{
  readonly message: string;
}> {}

export class LegacyGenTypesUnexpectedStatusError extends Data.TaggedError(
  "LegacyGenTypesUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyInvalidGenTypesDurationError extends Data.TaggedError(
  "LegacyInvalidGenTypesDurationError",
)<{
  readonly message: string;
}> {}

export class LegacyInvalidGenTypesDatabaseUrlError extends Data.TaggedError(
  "LegacyInvalidGenTypesDatabaseUrlError",
)<{
  readonly message: string;
}> {}
