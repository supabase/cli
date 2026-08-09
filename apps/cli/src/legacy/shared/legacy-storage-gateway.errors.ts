import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * Errors for the Supabase Storage **service gateway** (Kong), shared by every
 * command that talks to Storage directly (`seed buckets`, `storage ls/cp/mv/rm`).
 * Mirrors Go's `pkg/fetcher` error shapes:
 *   - transport failure (`failed to execute http request`) →
 *     `LegacyStorageGatewayNetworkError`
 *   - non-200 response (`Error status <d>: <body>`, `pkg/fetcher/http.go:112`) →
 *     `LegacyStorageGatewayStatusError`
 *
 * `message` reproduces Go's verbatim error text. `body` is carried on the status
 * error so callers can classify it (e.g. `mv`'s `"error":"not_found"` and `rm`'s
 * `"error":"Bucket not found"` substrings, and `seed`'s vector graceful-skip).
 */
export class LegacyStorageGatewayNetworkError extends Data.TaggedError(
  "LegacyStorageGatewayNetworkError",
)<{
  readonly message: string;
  /**
   * Set when this failure is a 200-response body that failed to decode
   * (`failParse`) rather than a transport failure — so a malformed-body decode
   * classifies as an API response problem instead of a network problem.
   */
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyStorageGatewayStatusError extends Data.TaggedError(
  "LegacyStorageGatewayStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The tenant Storage gateway is not the Management API: a 401/403 here
    // means stale local service keys, which `supabase login` cannot fix, so
    // the Management-API auth/permission policy must not apply. This tag also
    // spans collection and capability-probe routes (including unsupported
    // vector routes returning 404), so it cannot safely opt every 404 into the
    // named-resource policy.
    if (this.status === 401 || this.status === 403) {
      return { ...actionability.apiStatus, fingerprint_suffix: "gateway_auth" };
    }
    return statusCodeActionability(this.status);
  }
}

export type LegacyStorageGatewayError =
  | LegacyStorageGatewayNetworkError
  | LegacyStorageGatewayStatusError;
