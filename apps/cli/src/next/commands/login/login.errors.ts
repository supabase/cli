import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

function LoginError<Tag extends string>(tag: Tag) {
  return class extends Data.TaggedError(tag)<{
    readonly detail: string;
    readonly suggestion: string;
  }> {
    override get message() {
      return `${this.detail}\n  Suggestion: ${this.suggestion}`;
    }
  };
}

export class NoTtyError extends LoginError("NoTtyError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authToken;
  }
}
export class LoginFailedError extends LoginError("LoginFailedError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}
