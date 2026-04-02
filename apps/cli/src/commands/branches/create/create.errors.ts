import { Data } from "effect";

export class NoBranchNameError extends Data.TaggedError("NoBranchNameError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {}

export class BranchAlreadyExistsError extends Data.TaggedError("BranchAlreadyExistsError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {}
