import { SupabaseApiInputError, type SupabaseApiError } from "@supabase/api/effect";
import { Effect } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

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

/**
 * Truncate + sanitize a response body for inclusion in an error message.
 * Mirrors the policy applied by `mapLegacyHttpError` so handlers that bypass
 * the typed client (e.g. `sso add` and `sso update` raw-HTTP POST/PUT) can
 * share the same defence-in-depth.
 */
export function sanitizeLegacyErrorBody(input: string): string {
  const capped = input.length > MAX_BODY_LEN ? input.slice(0, MAX_BODY_LEN) : input;
  return sanitizeErrorBody(capped);
}

/**
 * Sanitizes an API-provided NAME (branch/project/org) for inline embedding in
 * a single-line terminal message. `sanitizeLegacyErrorBody` deliberately
 * preserves `\n`/`\t` so JSON response bodies stay readable — but inside an
 * inline name those characters let a hostile name forge additional CLI output
 * lines (PR #6168 review). Collapse them to a single space on top of the
 * body sanitizer's control-char stripping and length cap.
 */
export function legacySanitizeInlineName(input: string): string {
  return sanitizeLegacyErrorBody(input).replace(/[\n\t]+/g, " ");
}

// Strip ASCII control characters from the response body before embedding it in an error
// message. The Management API is trusted, but defence-in-depth: a body containing `\r\n`
// could fracture a structured log line, and `\x00` could truncate output in shells that
// treat NUL as EOS. Tab is preserved so JSON whitespace round-trips visually intact.
function sanitizeErrorBody(input: string): string {
  // Strip ASCII control chars except \t (0x09), \n (0x0a), \r (0x0d) and DEL (0x7f).
  // Then also strip CR — we keep \n and \t because they appear in legitimate JSON
  // pretty-printing and shouldn't visually corrupt single-line stderr output.
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const isLowCtrl = code < 0x20 && code !== 0x09 && code !== 0x0a;
    const isDel = code === 0x7f;
    const isCr = code === 0x0d;
    if (isLowCtrl || isDel || isCr) continue;
    out += input[i];
  }
  return out;
}

export type NetworkErrorFactory<E> = new (args: {
  readonly message: string;
  readonly decode?: boolean;
}) => E;

export type StatusErrorFactory<E> = new (args: {
  readonly status: number;
  readonly body: string;
  readonly message: string;
}) => E;

/**
 * Build an error mapper that classifies a `SupabaseApiError` into either a typed network
 * error or a typed unexpected-status error. Pulled out of individual command families so
 * they share the dispatch logic, the body truncation, and the `RESPONSE_ERROR_TAGS` policy.
 *
 * `networkMessage` and `statusMessage` are templates: they build the human-readable error
 * string with the same exact phrasing the Go CLI uses, so Go-parity status messages and
 * existing error-message assertions continue to hold.
 */
export function mapLegacyHttpError<N, S>(opts: {
  readonly networkError: NetworkErrorFactory<N>;
  readonly statusError: StatusErrorFactory<S>;
  readonly networkMessage: (cause: string) => string;
  readonly statusMessage: (status: number, body: string) => string;
}): (
  cause: SupabaseApiError,
) => Effect.Effect<never, N | S | SupabaseApiInputError | HttpBody.HttpBodyError> {
  return (cause) =>
    Effect.gen(function* () {
      if (cause instanceof SupabaseApiInputError || cause instanceof HttpBody.HttpBodyError) {
        // These failures occur while the generated client validates or builds
        // the request. Keep their identity because this generic mapper cannot
        // safely infer user provenance or reclassify them as response errors.
        return yield* Effect.fail(cause);
      }
      if (HttpClientError.isHttpClientError(cause)) {
        if (RESPONSE_ERROR_TAGS.has(cause.reason._tag) && cause.response !== undefined) {
          const status = cause.response.status;
          const rawBody = yield* cause.response.text.pipe(
            Effect.orElseSucceed(() => cause.reason.description ?? ""),
          );
          const body = sanitizeLegacyErrorBody(rawBody);
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
      // SchemaError — the server returned a response whose body failed schema
      // decoding (a 200 the generated client could not parse). This is not a
      // transport failure, so flag `decode` to classify it as an API-response
      // problem rather than a network problem.
      return yield* Effect.fail(
        new opts.networkError({ message: opts.networkMessage(String(cause)), decode: true }),
      );
    });
}
