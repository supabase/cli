import type { SupabaseApiError } from "@supabase/api/effect";
import { Data, Effect } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

export class LegacyBackupListNetworkError extends Data.TaggedError("LegacyBackupListNetworkError")<{
  readonly message: string;
}> {}

export class LegacyBackupListUnexpectedStatusError extends Data.TaggedError(
  "LegacyBackupListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyBackupRestoreNetworkError extends Data.TaggedError(
  "LegacyBackupRestoreNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyBackupRestoreUnexpectedStatusError extends Data.TaggedError(
  "LegacyBackupRestoreUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

// HttpClientError reasons that indicate the server returned an actual response (vs a transport
// failure). Anything in this set surfaces as an `UnexpectedStatusError`; everything else maps
// to a `NetworkError`.
const RESPONSE_ERROR_TAGS: ReadonlySet<HttpClientError.HttpClientErrorReason["_tag"]> = new Set([
  "StatusCodeError",
  "DecodeError",
  "EmptyBodyError",
]);

// Caps the response body that gets embedded in error structures. The Management API is
// trusted, but capping prevents oversized error envelopes from flooding `--output-format json`
// and avoids forwarding arbitrary bytes verbatim if the trust boundary ever changes.
const MAX_BODY_LEN = 1024;

type NetworkErrorFactory<E> = new (args: { readonly message: string }) => E;

type StatusErrorFactory<E> = new (args: {
  readonly status: number;
  readonly body: string;
  readonly message: string;
}) => E;

/**
 * Build an error mapper that classifies a `SupabaseApiError` into either a typed network
 * error or a typed unexpected-status error. Pulled out of the handlers so both commands
 * share the dispatch logic, the body truncation, and the `RESPONSE_ERROR_TAGS` policy.
 *
 * `networkMessage` and `statusMessage` are templates: they build the human-readable error
 * string with the same exact phrasing the handlers used before, so existing error-message
 * assertions (and Go parity for status messages) continue to hold.
 */
export function mapLegacyBackupHttpError<N, S>(opts: {
  readonly networkError: NetworkErrorFactory<N>;
  readonly statusError: StatusErrorFactory<S>;
  readonly networkMessage: (cause: string) => string;
  readonly statusMessage: (status: number, body: string) => string;
}): (cause: SupabaseApiError) => Effect.Effect<never, N | S> {
  return (cause) =>
    Effect.gen(function* () {
      if (HttpClientError.isHttpClientError(cause)) {
        if (RESPONSE_ERROR_TAGS.has(cause.reason._tag) && cause.response !== undefined) {
          const status = cause.response.status;
          const rawBody = yield* cause.response.text.pipe(
            Effect.orElseSucceed(() => cause.reason.description ?? ""),
          );
          const body = rawBody.length > MAX_BODY_LEN ? rawBody.slice(0, MAX_BODY_LEN) : rawBody;
          return yield* Effect.fail(
            new opts.statusError({
              status,
              body,
              message: opts.statusMessage(status, body),
            }),
          );
        }
        const description = cause.reason.description ?? cause.reason._tag;
        return yield* Effect.fail(
          new opts.networkError({ message: opts.networkMessage(description) }),
        );
      }
      // SchemaError or HttpBodyError — treat as transport-level network error.
      return yield* Effect.fail(
        new opts.networkError({ message: opts.networkMessage(String(cause)) }),
      );
    });
}
