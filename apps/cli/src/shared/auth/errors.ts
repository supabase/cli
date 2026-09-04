import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../telemetry/error-actionability.ts";

export class InvalidTokenError extends Data.TaggedError("InvalidTokenError")<{
  readonly detail: string;
  readonly suggestion: string;
  /**
   * Where the malformed token came from. Direct-input tokens (`--token` flag,
   * `SUPABASE_ACCESS_TOKEN`, piped stdin) cannot be fixed by `supabase login`,
   * so their remediation is to correct that input. A token from the browser
   * flow (no source) is fixable by logging in again.
   */
  readonly source?: "env" | "flag" | "stdin";
}> {
  override get message() {
    return `${this.detail}\n  Suggestion: ${this.suggestion}`;
  }
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.source === undefined ? actionability.authLogin : actionability.authToken;
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
