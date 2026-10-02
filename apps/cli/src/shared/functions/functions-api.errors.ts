import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../telemetry/error-actionability.ts";

/**
 * Non-OK Management API response with an HTTP status code, shared by
 * `deploy.ts` and `download.ts` so both classify it identically via
 * {@link statusCodeActionability} instead of an `unknown` plain `Error`.
 */
export class FunctionsApiStatusError extends Data.TaggedError("FunctionsApiStatusError")<{
  readonly status: number;
  readonly message: string;
  /** The request path names a user-selected function slug. */
  readonly notFoundIsInvalidInput?: boolean;
  /**
   * Set when a successful-status response's body failed to decode. Classifies
   * as `api_status` with the `api_response` fingerprint instead of the status-code policy.
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
 * Management API request that failed before a response arrived (DNS,
 * connection reset, timeout, ...), shared by `deploy.ts` and
 * `download.ts`'s `mapTransportError` so both classify it as a network
 * failure instead of an `unknown` plain `Error`.
 */
export class FunctionsApiTransportError extends Data.TaggedError("FunctionsApiTransportError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
  }
}
