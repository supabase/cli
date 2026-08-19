import { Effect, Layer } from "effect";
import {
  feedbackClientLayer,
  legacyFeedbackEnvironment,
} from "../../../shared/feedback/feedback-client.layer.ts";
import { LegacyDnsResolverFlag } from "../../../shared/legacy/global-flags.ts";
import { legacyCliConfigLayer } from "../../config/legacy-cli-config.layer.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { legacyDebugLoggerLayer } from "../../shared/legacy-debug-logger.layer.ts";
import type { LegacyDebugLoggerShape } from "../../shared/legacy-debug-logger.service.ts";
import { LegacyDebugLogger } from "../../shared/legacy-debug-logger.service.ts";
import { legacyDohFetch, type LegacyDohFetchOptions } from "../../shared/legacy-http-dns.ts";

export const legacyFeedbackCliConfigLayer = legacyCliConfigLayer.pipe(
  Layer.provide(legacyDebugLoggerLayer),
);

interface LegacyFeedbackFetchOptions {
  readonly dnsResolver: "native" | "https";
  readonly logger: LegacyDebugLoggerShape;
  /** Injectable inner transport for hermetic tests; defaults to `globalThis.fetch`. */
  readonly innerFetch?: typeof globalThis.fetch;
  /** Injectable DoH resolver for hermetic tests; defaults to the real Cloudflare DoH lookup. */
  readonly resolver?: LegacyDohFetchOptions["resolver"];
}

// The preview/delete requests carry the row's capability token as a
// `delete_token=eq.<uuid>` PostgREST filter. Unlike the Management API (whose
// credentials ride in never-logged headers), that puts a secret in the URL —
// redact it before the gated stderr write so `--debug` output pasted into
// issues, CI logs, or support threads never grants read/delete authority over
// the row. The transport still receives the original URL.
function redactDeleteToken(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("delete_token")) return url;
  parsed.searchParams.set("delete_token", "eq.redacted");
  return parsed.toString();
}

/**
 * The feedback client speaks `fetch` (supabase-js), not Effect's `HttpClient`,
 * so the two legacy transport behaviors every command promises compose at the
 * fetch boundary instead of through `legacyHttpClientLayer`: `--debug` request
 * logging on stderr (with the delete-token filter redacted), wrapping the
 * `--dns-resolver https` DoH resolution.
 */
export function legacyFeedbackFetch(options: LegacyFeedbackFetchOptions): typeof globalThis.fetch {
  const { dnsResolver, logger } = options;
  const dohFetch = legacyDohFetch({
    dnsResolver,
    innerFetch: options.innerFetch,
    resolver: options.resolver,
  });
  return Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // The logger's write is synchronous (a gated stderr write); running it
      // at this plain-fetch boundary keeps the wrapper a `typeof fetch`.
      Effect.runSync(logger.http(method, redactDeleteToken(url)));
      return dohFetch(input, init);
    },
    { preconnect: globalThis.fetch.preconnect },
  );
}

export const legacyFeedbackClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* LegacyCliConfig;
    const dnsResolver = yield* LegacyDnsResolverFlag;
    const logger = yield* LegacyDebugLogger;
    return feedbackClientLayer({
      environment: legacyFeedbackEnvironment(config.profile),
      fetch: legacyFeedbackFetch({ dnsResolver, logger }),
    });
  }),
).pipe(Layer.provide(legacyFeedbackCliConfigLayer), Layer.provide(legacyDebugLoggerLayer));
