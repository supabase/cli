import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../telemetry/error-actionability.ts";

/**
 * Shared error for a non-OK Management API response where an HTTP status
 * code is available, used by both `deploy.ts` and `download.ts`. Keeping one
 * class here (rather than duplicating it per file) lets both call sites
 * classify identically via {@link statusCodeActionability} instead of
 * falling back to a plain `Error` (which reports as `unknown` in the error
 * actionability KPI).
 */
export class FunctionsApiStatusError extends Data.TaggedError("FunctionsApiStatusError")<{
  readonly status: number;
  readonly message: string;
  /** The request path names a user-selected function slug. */
  readonly notFoundIsInvalidInput?: boolean;
  /**
   * Set when the failure is a successful-status response whose body could not
   * be decoded (status is 200/201 but the JSON is malformed / unexpected).
   * That is an API-response problem, not a raw status failure, so it classifies
   * as `api_status` with the `api_response` fingerprint ahead of the
   * status-code policy.
   */
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.decode === true) {
      return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
    }
    return statusCodeActionability(this.status, {
      notFoundIsInvalidInput: this.notFoundIsInvalidInput,
    });
  }
}

/**
 * Shared error for a Management API request that failed before a response
 * was received (DNS, connection reset, timeout, ...), used by both
 * `deploy.ts` and `download.ts`'s `mapTransportError`. Keeping one class here
 * (rather than duplicating it per file) lets both call sites classify
 * identically as a network failure instead of falling back to a plain
 * `Error` (which reports as `unknown` in the error actionability KPI).
 */
export class FunctionsApiTransportError extends Data.TaggedError("FunctionsApiTransportError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
  }
}
