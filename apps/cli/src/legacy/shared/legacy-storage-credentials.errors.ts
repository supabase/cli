import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * Errors raised while deriving Storage connection credentials, shared by
 * `seed buckets` and `storage ls/cp/mv/rm`.
 *
 * `LegacyStorageConfigError` covers the config-load-time validations run
 * before the Storage API client is built (`auth.jwt_secret` length, Kong TLS cert/key pairing
 * and readability, a malformed `SUPABASE_API_*` port/bool override, and an
 * unreadable/malformed project dotenv file — see `resolveLocalApiConfig`).
 * The remaining three mirror `tenant.GetApiKeys` failure
 * modes on the `--linked` path.
 */
export class LegacyStorageConfigError extends Data.TaggedError("LegacyStorageConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Raised on `--linked` when the project's api-keys response yields no keys,
 * mirroring `tenant.GetApiKeys` → `errMissingKey` ("Anon key not found."),
 * which aborts before the remote
 * Storage client is built.
 */
export class LegacyStorageMissingApiKeyError extends Data.TaggedError(
  "LegacyStorageMissingApiKeyError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // A 200 api-keys response with no usable key — an API response problem, not
    // a raw status failure.
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

/** Transport failure fetching the project's api-keys (`failed to get api keys: <cause>`). */
export class LegacyStorageApiKeysNetworkError extends Data.TaggedError(
  "LegacyStorageApiKeysNetworkError",
)<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/**
 * `GET /v1/projects/{ref}/api-keys?reveal=true` returned a non-200 on a
 * `--linked` run. Byte-matches `tenant.GetApiKeys` → `ErrAuthToken`,
 * `"Authorization failed for the access token and project ref pair: " + body`.
 */
export class LegacyStorageAuthTokenError extends Data.TaggedError("LegacyStorageAuthTokenError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The shared mapper wraps any non-200 in this tag; the status policy maps
    // 401 → re-login, 404 → user-supplied ref not found, everything else →
    // API status.
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}
