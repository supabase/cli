import { Data } from "effect";

export class InvalidFunctionSlugError extends Data.TaggedError("InvalidFunctionSlugError")<{
  readonly message: string;
}> {}

export class FunctionNotFoundError extends Data.TaggedError("FunctionNotFoundError")<{
  readonly message: string;
}> {}

export class DeleteFunctionNetworkError extends Data.TaggedError("DeleteFunctionNetworkError")<{
  readonly message: string;
}> {}

export class DeleteFunctionUnexpectedStatusError extends Data.TaggedError(
  "DeleteFunctionUnexpectedStatusError",
)<{
  readonly message: string;
}> {}
