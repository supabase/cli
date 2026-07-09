import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

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

export class InvalidTokenError extends CliError("InvalidTokenError") {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly statusCode?: number;
  readonly detail: string;
  /**
   * Set when this error represents a body/schema decode failure on an
   * otherwise-successful response (no status code to classify by), rather
   * than a transport failure — so it classifies as an API response problem
   * instead of a network problem.
   */
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.statusCode !== undefined) {
      return statusCodeActionability(this.statusCode);
    }
    if (this.decode === true) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
    }
    return statusCodeActionability(undefined);
  }
}

export class PlatformAuthRequiredError extends Data.TaggedError("PlatformAuthRequiredError")<{
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}
