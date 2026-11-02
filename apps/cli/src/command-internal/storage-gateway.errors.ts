import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Errors for the Supabase Storage service gateway (Kong): a transport
 * failure (`StorageGatewayNetworkError`) or non-200 response
 * (`StorageGatewayStatusError`), with `body` kept for error classification.
 */
export class StorageGatewayNetworkError extends Data.TaggedError("StorageGatewayNetworkError")<{
  readonly message: string;
  /**
   * Set when this is a 200-response body that failed to decode, rather than a
   * transport failure, so it classifies as an API response problem instead of
   * a network problem.
   */
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class StorageGatewayStatusError extends Data.TaggedError("StorageGatewayStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // A 401/403 here means stale local service keys, not a login problem, so
    // the Management-API auth policy doesn't apply. This tag also covers
    // capability-probe routes where a 404 isn't a named-resource lookup.
    if (this.status === 401 || this.status === 403) {
      return { ...actionability.apiStatus, fingerprint_suffix: "gateway_auth" };
    }
    return statusCodeActionability(this.status);
  }
}

export type StorageGatewayError = StorageGatewayNetworkError | StorageGatewayStatusError;
