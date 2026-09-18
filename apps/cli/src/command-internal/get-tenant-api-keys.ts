import { mapHttpError, type NetworkErrorFactory, type StatusErrorFactory } from "./http-errors.ts";

/**
 * Error mapper for resolving a project's service-role key: a transport failure maps to
 * `failed to get api keys: <cause>`, and a non-200 response maps to `Authorization failed for the
 * access token and project ref pair: <body>`.
 *
 * Shared by `link` and `seed buckets`; parameterized on the caller's tagged-error classes so each
 * keeps its own error tags while sharing this message shape.
 */
export const mapTenantApiKeysError = <N, S>(opts: {
  readonly networkError: NetworkErrorFactory<N>;
  readonly statusError: StatusErrorFactory<S>;
}) =>
  mapHttpError({
    networkError: opts.networkError,
    statusError: opts.statusError,
    networkMessage: (cause) => `failed to get api keys: ${cause}`,
    statusMessage: (_status, body) =>
      `Authorization failed for the access token and project ref pair: ${body}`,
  });
