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
 * Truncates and sanitizes a response body for inclusion in an error message.
 * Shared by handlers that bypass the typed client (e.g. `sso add`/`sso update`
 * raw-HTTP POST/PUT) and `mapHttpError`, so both apply the same defense-in-depth.
 */
export function sanitizeErrorBody(input: string): string {
  const capped = input.length > MAX_BODY_LEN ? input.slice(0, MAX_BODY_LEN) : input;
  return stripControlChars(capped);
}

/**
 * Sanitizes an API-provided name (branch/project/org) for inline embedding in
 * a single-line terminal message. Collapses `\n`/`\t` — preserved by
 * `sanitizeErrorBody` for JSON readability — to a single space, so a hostile
 * name can't forge additional output lines.
 */
export function sanitizeInlineName(input: string): string {
  return sanitizeErrorBody(input).replace(/[\n\t]+/g, " ");
}

/**
 * Renders `name (ref)` when `name` is non-empty after sanitization via
 * {@link sanitizeInlineName}, or bare `ref` otherwise. Gating on the
 * sanitized length (not the raw input's) keeps a name of only control
 * characters from rendering as `` (ref)`` with a phantom leading space.
 */
export function formatNamedRef(name: string | undefined, ref: string): string {
  const safeRef = sanitizeInlineName(ref);
  const safeName = name === undefined ? undefined : sanitizeInlineName(name);
  return safeName === undefined || safeName.length === 0 ? safeRef : `${safeName} (${safeRef})`;
}

// Strips ASCII control chars, DEL, C1 controls (U+0080-U+009F, e.g. the CSI
// equivalent U+009B), bidi override chars (can reorder/hide terminal text),
// and Unicode line separators — defense-in-depth against escape injection,
// spoofing, and log-line fracturing. `\n` and `\t` are kept for JSON readability.
// Exported for the `feedback delete` preview, which renders untrusted
// submitter text uncapped.
export function stripControlChars(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const isLowCtrl = code < 0x20 && code !== 0x09 && code !== 0x0a;
    const isDel = code === 0x7f;
    const isCr = code === 0x0d;
    const isC1 = code >= 0x80 && code <= 0x9f;
    const isBidiControl =
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    const isLineSeparator = code === 0x2028 || code === 0x2029;
    if (isLowCtrl || isDel || isCr || isC1 || isBidiControl || isLineSeparator) continue;
    out += input[i];
  }
  return out;
}

/**
 * The generic status-message shape a `statusMessage` callback (passed to
 * `mapHttpError`/`classifyProjectLookupError`) falls back to when it has no
 * purpose-written message for the status it received.
 */
export function unexpectedStatusMessage(status: number, body: string): string {
  return `unexpected status ${status}: ${body}`;
}

/** Shared remediation for Management API requests rejected with HTTP 401. */
export const AUTHENTICATION_FAILED_STATUS_MESSAGE =
  "Authentication failed: your access token is invalid or has expired. Run `supabase login` to re-authenticate.";

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
 * Builds an error mapper that classifies a `SupabaseApiError` into either a
 * typed network error or a typed unexpected-status error. Shared by command
 * families for consistent dispatch logic, body truncation, and the
 * `RESPONSE_ERROR_TAGS` policy.
 *
 * `networkMessage` and `statusMessage` build the exact error-message wording
 * each command's established output and tests expect.
 */
export function mapHttpError<N, S>(opts: {
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
        // Client-side validation/build failures: keep their identity, since
        // this generic mapper can't safely reclassify them as response errors.
        return yield* Effect.fail(cause);
      }
      if (HttpClientError.isHttpClientError(cause)) {
        if (RESPONSE_ERROR_TAGS.has(cause.reason._tag) && cause.response !== undefined) {
          const status = cause.response.status;
          const rawBody = yield* cause.response.text.pipe(
            Effect.orElseSucceed(() => cause.reason.description ?? ""),
          );
          const body = sanitizeErrorBody(rawBody);
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
      // SchemaError: a 200 response whose body failed schema decoding. Not a
      // transport failure, so flag `decode` to classify it as an API-response
      // problem rather than a network problem.
      return yield* Effect.fail(
        new opts.networkError({ message: opts.networkMessage(String(cause)), decode: true }),
      );
    });
}
