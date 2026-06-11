import { Data } from "effect";

export class InvalidFunctionSlugError extends Data.TaggedError("InvalidFunctionSlugError")<{
  readonly message: string;
}> {}

export class ConflictingFunctionDownloadFlagsError extends Data.TaggedError(
  "ConflictingFunctionDownloadFlagsError",
)<{
  readonly message: string;
}> {}

export class FunctionDownloadNotFoundError extends Data.TaggedError(
  "FunctionDownloadNotFoundError",
)<{
  readonly message: string;
}> {}

export class InvalidFunctionDownloadResponseError extends Data.TaggedError(
  "InvalidFunctionDownloadResponseError",
)<{
  readonly message: string;
}> {}

export class UnsafeFunctionDownloadPathError extends Data.TaggedError(
  "UnsafeFunctionDownloadPathError",
)<{
  readonly message: string;
}> {}
