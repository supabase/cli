import { Data } from "effect";

export class InvalidFunctionSlugError extends Data.TaggedError("InvalidFunctionSlugError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {}

export class MissingFunctionSlugError extends Data.TaggedError("MissingFunctionSlugError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {}

export class FunctionEntrypointExistsError extends Data.TaggedError(
  "FunctionEntrypointExistsError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {}
