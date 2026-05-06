import { Data } from "effect";

export class ProjectRefRequiredError extends Data.TaggedError("ProjectRefRequiredError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {}

export class NoAccessibleProjectsError extends Data.TaggedError("NoAccessibleProjectsError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {}
