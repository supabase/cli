import { Effect, Layer } from "effect";
import {
  feedbackClientLayer,
  feedbackEnvironment,
} from "../../shared/feedback/feedback-client.layer.ts";
import { DnsResolverFlag } from "../../command-internal/global-flags.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import type { DebugLoggerShape } from "../../command-internal/debug-logger.service.ts";
import { DebugLogger } from "../../command-internal/debug-logger.service.ts";
import { dohFetch, type DohFetchOptions } from "../../command-internal/http-dns.ts";

export const feedbackCliConfigLayer = commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer));

interface FeedbackFetchOptions {
  readonly dnsResolver: "native" | "https";
  readonly logger: DebugLoggerShape;
  /** Injectable inner transport for hermetic tests; defaults to `globalThis.fetch`. */
  readonly innerFetch?: typeof globalThis.fetch;
  /** Injectable DoH resolver for hermetic tests; defaults to the real Cloudflare DoH lookup. */
  readonly resolver?: DohFetchOptions["resolver"];
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
 * so the two transport behaviors every command promises compose at the
 * fetch boundary instead of through `httpClientLayer`: `--debug` request
 * logging on stderr (with the delete-token filter redacted), wrapping the
 * `--dns-resolver https` DoH resolution.
 */
export function feedbackFetch(options: FeedbackFetchOptions): typeof globalThis.fetch {
  const { dnsResolver, logger } = options;
  const dohFetchInstance = dohFetch({
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
      return dohFetchInstance(input, init);
    },
    { preconnect: globalThis.fetch.preconnect },
  );
}

export const commandFeedbackClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* CommandSettings;
    const dnsResolver = yield* DnsResolverFlag;
    const logger = yield* DebugLogger;
    return feedbackClientLayer({
      environment: feedbackEnvironment(config.profile),
      fetch: feedbackFetch({ dnsResolver, logger }),
    });
  }),
).pipe(Layer.provide(feedbackCliConfigLayer), Layer.provide(debugLoggerLayer));
