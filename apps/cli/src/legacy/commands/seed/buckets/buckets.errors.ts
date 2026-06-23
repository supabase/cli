import { Data } from "effect";

/**
 * Domain errors for `supabase seed buckets`.
 *
 * The Storage service-gateway calls fail with one of two shapes, mirroring Go's
 * `pkg/fetcher`:
 *   - transport failure (`failed to execute http request`) →
 *     `LegacySeedStorageNetworkError`
 *   - non-2xx response (`Error status <d>: <body>`, `pkg/fetcher/http.go:112`) →
 *     `LegacySeedStorageStatusError`
 *
 * `message` reproduces Go's verbatim error text so the vector graceful-skip
 * classifiers in `buckets.classify.ts` match on the same substrings Go inspects.
 */
export class LegacySeedStorageNetworkError extends Data.TaggedError(
  "LegacySeedStorageNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacySeedStorageStatusError extends Data.TaggedError("LegacySeedStorageStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

/**
 * Raised when `supabase/config.toml` cannot be parsed. Mirrors the `config push`
 * CLI-1489 tradeoff (`config/push/push.handler.ts:96-114`): `loadProjectConfig`
 * raises `ProjectConfigParseError` on `env(...)` refs over numeric/bool fields,
 * which Go resolves transparently.
 */
export class LegacySeedConfigLoadError extends Data.TaggedError("LegacySeedConfigLoadError")<{
  readonly message: string;
}> {}

/**
 * Raised when `--local` and `--linked` are both passed, reproducing cobra's
 * `MarkFlagsMutuallyExclusive("local", "linked")` (`apps/cli-go/cmd/seed.go:32`).
 */
export class LegacySeedMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacySeedMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {}

/**
 * Raised on `--linked` when the project's api-keys response yields no keys,
 * mirroring Go's `tenant.GetApiKeys` → `errMissingKey` ("Anon key not found.",
 * `apps/cli-go/internal/utils/tenant/client.go:16,80-82`), which aborts before
 * the remote Storage client is built. Message matches Go verbatim.
 */
export class LegacySeedMissingApiKeyError extends Data.TaggedError("LegacySeedMissingApiKeyError")<{
  readonly message: string;
}> {}

/**
 * Transport failure fetching the project's api-keys on `--linked`, mirroring Go's
 * `tenant.GetApiKeys` network path (`failed to get api keys: <cause>`).
 */
export class LegacySeedApiKeysNetworkError extends Data.TaggedError(
  "LegacySeedApiKeysNetworkError",
)<{
  readonly message: string;
}> {}

/**
 * `GET /v1/projects/{ref}/api-keys?reveal=true` returned a non-200 status on a
 * `--linked` run. Byte-matches Go's `tenant.GetApiKeys` → `ErrAuthToken`,
 * `"Authorization failed for the access token and project ref pair: " + body`
 * (`apps/cli-go/internal/utils/tenant/client.go:15,77-78`). This is the user-facing
 * error for an invalid access token / project-ref pair — distinct from the
 * `projects api-keys` helper's `unexpected get api keys status ...`.
 */
export class LegacySeedAuthTokenError extends Data.TaggedError("LegacySeedAuthTokenError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}
