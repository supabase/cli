import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Config-load-time failure while deriving local Storage credentials, before
 * the Storage API client is built: an invalid or undecryptable auth secret,
 * a Kong TLS cert/key pairing or readability problem, a malformed
 * `SUPABASE_API_*` override, or an unreadable project dotenv file.
 */
export class StorageConfigError extends Data.TaggedError("StorageConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Raised on `--linked` when the project's api-keys response yields no usable key. */
export class StorageMissingApiKeyError extends Data.TaggedError("StorageMissingApiKeyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // A 200 response with no usable key, not a raw status failure.
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

/** Transport failure fetching the project's api-keys (`failed to get api keys: <cause>`). */
export class StorageApiKeysNetworkError extends Data.TaggedError("StorageApiKeysNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** Raised when `GET /v1/projects/{ref}/api-keys?reveal=true` returns a non-200 status on a `--linked` run. */
export class StorageAuthTokenError extends Data.TaggedError("StorageAuthTokenError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // 401 → re-login, 404 → user-supplied ref not found, everything else → API status.
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}
