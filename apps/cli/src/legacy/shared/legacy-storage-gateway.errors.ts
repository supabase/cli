import { Data } from "effect";

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
}> {}

export class LegacyStorageGatewayStatusError extends Data.TaggedError(
  "LegacyStorageGatewayStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export type LegacyStorageGatewayError =
  | LegacyStorageGatewayNetworkError
  | LegacyStorageGatewayStatusError;
