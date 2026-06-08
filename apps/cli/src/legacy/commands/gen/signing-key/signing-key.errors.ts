import { Data } from "effect";

export class LegacyGenSigningKeyConfigParseError extends Data.TaggedError(
  "LegacyGenSigningKeyConfigParseError",
)<{
  readonly message: string;
}> {}

export class LegacyGenSigningKeyGenerateError extends Data.TaggedError(
  "LegacyGenSigningKeyGenerateError",
)<{
  readonly message: string;
}> {}

export class LegacyGenSigningKeyReadError extends Data.TaggedError("LegacyGenSigningKeyReadError")<{
  readonly message: string;
}> {}

export class LegacyGenSigningKeyDecodeError extends Data.TaggedError(
  "LegacyGenSigningKeyDecodeError",
)<{
  readonly message: string;
}> {}

export class LegacyGenSigningKeyWriteError extends Data.TaggedError(
  "LegacyGenSigningKeyWriteError",
)<{
  readonly message: string;
}> {}

export class LegacyGenSigningKeyCancelledError extends Data.TaggedError(
  "LegacyGenSigningKeyCancelledError",
)<{
  readonly message: string;
}> {}
