import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { legacyDohFetchLayer } from "../shared/legacy-http-dns.ts";
import { LegacyDebugLogger } from "../shared/legacy-debug-logger.service.ts";

/**
 * Wraps `FetchHttpClient.layer` so every HTTP request can go through the
 * legacy Go-parity debug side channel. The logger itself owns the `--debug`
 * guard and byte-for-byte line formatting.
 *
 * `legacyDohFetchLayer` overrides `FetchHttpClient.Fetch` with a
 * DNS-over-HTTPS-aware fetch when `--dns-resolver https` is set, mirroring
 * Go's `withFallbackDNS` transport hook
 * (`apps/cli-go/internal/utils/api.go:85-104`).
 */
export const legacyHttpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const logger = yield* LegacyDebugLogger;
    const base = yield* HttpClient.HttpClient;
    return HttpClient.mapRequestEffect(base, (req) =>
      logger.http(req.method, req.url).pipe(Effect.as(req)),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(legacyDohFetchLayer));
