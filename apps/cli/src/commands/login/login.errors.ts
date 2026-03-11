import { Data } from "effect";

function LoginError<Tag extends string>(tag: Tag) {
  return class extends Data.TaggedError(tag)<{
    readonly detail: string;
    readonly suggestion: string;
  }> {};
}

export class NoTtyError extends LoginError("NoTtyError") {}
export class LoginFailedError extends LoginError("LoginFailedError") {}
