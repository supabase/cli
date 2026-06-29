import { Data } from "effect";

/**
 * Errors raised while deriving Storage connection credentials, shared by
 * `seed buckets` and `storage ls/cp/mv/rm`.
 *
 * `LegacyStorageConfigError` covers the config-load-time validations Go runs
 * before `NewStorageAPI` (`auth.jwt_secret` length, Kong TLS cert/key pairing
 * and readability). The remaining three mirror Go's `tenant.GetApiKeys` failure
 * modes on the `--linked` path (`internal/utils/tenant/client.go`).
 */
export class LegacyStorageConfigError extends Data.TaggedError("LegacyStorageConfigError")<{
  readonly message: string;
}> {}

/**
 * Raised on `--linked` when the project's api-keys response yields no keys,
 * mirroring Go's `tenant.GetApiKeys` → `errMissingKey` ("Anon key not found.",
 * `internal/utils/tenant/client.go:16,80-82`), which aborts before the remote
 * Storage client is built.
 */
export class LegacyStorageMissingApiKeyError extends Data.TaggedError(
  "LegacyStorageMissingApiKeyError",
)<{
  readonly message: string;
}> {}

/** Transport failure fetching the project's api-keys (`failed to get api keys: <cause>`). */
export class LegacyStorageApiKeysNetworkError extends Data.TaggedError(
  "LegacyStorageApiKeysNetworkError",
)<{
  readonly message: string;
}> {}

/**
 * `GET /v1/projects/{ref}/api-keys?reveal=true` returned a non-200 on a
 * `--linked` run. Byte-matches Go's `tenant.GetApiKeys` → `ErrAuthToken`,
 * `"Authorization failed for the access token and project ref pair: " + body`
 * (`internal/utils/tenant/client.go:15,77-78`).
 */
export class LegacyStorageAuthTokenError extends Data.TaggedError("LegacyStorageAuthTokenError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}
