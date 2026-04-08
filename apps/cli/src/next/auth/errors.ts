import { Data } from "effect";

function CliError<Tag extends string>(tag: Tag) {
  return class extends Data.TaggedError(tag)<{
    readonly detail: string;
    readonly suggestion: string;
  }> {
    override get message() {
      return `${this.detail}\n  Suggestion: ${this.suggestion}`;
    }
  };
}

export class InvalidTokenError extends CliError("InvalidTokenError") {}

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly statusCode?: number;
  readonly detail: string;
}> {}

export class PlatformAuthRequiredError extends Data.TaggedError("PlatformAuthRequiredError")<{
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
}> {}
