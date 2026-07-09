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
/**
 * All browser-login verification retries exhausted. Carries the LAST poll
 * failure's discriminant so classification distinguishes "the user never
 * completed the browser flow" (a pending 4xx, or no signal) from a genuine
 * platform problem (5xx / transport).
 */
export class LoginFailedError extends Data.TaggedError("LoginFailedError")<{
  readonly detail: string;
  readonly suggestion: string;
  readonly statusCode?: number;
  readonly network?: boolean;
}> {
  override get message() {
    return `${this.detail}\n  Suggestion: ${this.suggestion}`;
  }
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.network === true) {
      return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
    }
    if (this.statusCode !== undefined && this.statusCode >= 500) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_status" };
    }
    return actionability.authLogin;
  }
}
