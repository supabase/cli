import {
  mapLegacyHttpError,
  type NetworkErrorFactory,
  type StatusErrorFactory,
} from "./legacy-http-errors.ts";

/**
 * Error mapper for Go's `tenant.GetApiKeys`
 * (`apps/cli-go/internal/utils/tenant/client.go:70-84`): a transport failure maps
 * to `failed to get api keys: <cause>`; a non-200 response maps to Go's
 * `ErrAuthToken`, `Authorization failed for the access token and project ref
 * pair: <body>` (`client.go:15,77-78`).
 *
 * Both the `link` and `seed buckets` linked paths resolve the service-role key
 * through `tenant.GetApiKeys` — `seed buckets` via `client.NewStorageAPI`
 * (`internal/storage/client/api.go:22`), `link` directly — so both must surface
 * this exact message. This is distinct from the `projects api-keys` helper
 * (`legacy-get-api-keys.ts`), which ports `apiKeys.RunGetApiKeys` and maps a
 * non-200 to `unexpected get api keys status ...`.
 *
 * Parameterized on the caller's tagged-error classes so `link` and `seed` keep
 * their own `LegacyLink*` / `LegacySeed*` error tags while sharing the message
 * shape and the truncation / classification policy in `mapLegacyHttpError`.
 */
export const legacyMapTenantApiKeysError = <N, S>(opts: {
  readonly networkError: NetworkErrorFactory<N>;
  readonly statusError: StatusErrorFactory<S>;
}) =>
  mapLegacyHttpError({
    networkError: opts.networkError,
    statusError: opts.statusError,
    networkMessage: (cause) => `failed to get api keys: ${cause}`,
    statusMessage: (_status, body) =>
      `Authorization failed for the access token and project ref pair: ${body}`,
  });
