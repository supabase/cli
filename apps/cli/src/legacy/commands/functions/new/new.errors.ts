import { Data } from "effect";

export class LegacyFunctionsNewInvalidSlugError extends Data.TaggedError(
  "LegacyFunctionsNewInvalidSlugError",
)<{
  readonly message: string;
  readonly detail: string;
}> {}

export class LegacyFunctionsNewFileExistsError extends Data.TaggedError(
  "LegacyFunctionsNewFileExistsError",
)<{
  readonly path: string;
  readonly message: string;
  readonly suggestion: string;
}> {}

export class LegacyFunctionsNewWriteError extends Data.TaggedError("LegacyFunctionsNewWriteError")<{
  readonly path: string;
  readonly message: string;
}> {}
