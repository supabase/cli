import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { legacyDohFetchLayer } from "../shared/legacy-http-dns.ts";
import { LegacyDebugLogger } from "../shared/legacy-debug-logger.service.ts";

/**
 * Query parameters that mean the URL *is* a credential.
 *
 * A presigned object-store URL authorizes whoever holds it — for the Workers
 * build-context upload, to overwrite the archive a deploy is about to build
 * from. Logging one verbatim under `--debug` puts that in terminal scrollback
 * and in any CI log or bug report the output is pasted into.
 */
const PRESIGNED_QUERY_KEYS = [
  // AWS SigV4 and SigV2
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "awsaccesskeyid",
  // Google Cloud Storage V4
  "x-goog-signature",
  "x-goog-credential",
  // Azure SAS, and the generic spellings everything else uses
  "sig",
  "se",
  "signature",
  "token",
];

/**
 * The URL as it should appear in a debug log: unchanged, unless its query string
 * carries a signature, in which case the query is replaced wholesale.
 *
 * Redacting the whole query rather than the matched parameters keeps the
 * decision simple and cannot leak a sibling parameter that turns out to matter.
 * The path survives, which is what makes the line useful for debugging in the
 * first place.
 *
 * A denylist of known signature parameters, so it is by nature incomplete: a
 * provider spelling its signature something new would log verbatim until the
 * list learns about it. The alternative — redacting every query string — would
 * cost the debug log its usefulness on the Management API calls that are the
 * whole reason `--debug` exists. Add spellings here as they turn up.
 */
export function legacyRedactHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL we can reason about; log it as-is rather than swallow it.
    return url;
  }
  if (parsed.search === "") {
    return url;
  }
  const presigned = [...parsed.searchParams.keys()].some((key) =>
    PRESIGNED_QUERY_KEYS.includes(key.toLowerCase()),
  );
  if (!presigned) {
    return url;
  }
  return `${parsed.origin}${parsed.pathname}?<redacted>`;
}

/**
 * Wraps `FetchHttpClient.layer` so every HTTP request goes through the legacy
 * debug side channel. The logger itself owns the `--debug` guard and the
 * line formatting.
 *
 * `legacyDohFetchLayer` overrides `FetchHttpClient.Fetch` with a
 * DNS-over-HTTPS-aware fetch when `--dns-resolver https` is set.
 */
export const legacyHttpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const logger = yield* LegacyDebugLogger;
    const base = yield* HttpClient.HttpClient;
    return HttpClient.mapRequestEffect(base, (req) =>
      logger.http(req.method, legacyRedactHttpUrl(req.url)).pipe(Effect.as(req)),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(legacyDohFetchLayer));
