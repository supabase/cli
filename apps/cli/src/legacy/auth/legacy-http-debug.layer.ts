import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { LegacyDebugLogger } from "../shared/legacy-debug-logger.service.ts";

/**
 * Wraps `FetchHttpClient.layer` so every HTTP request can go through the
 * legacy Go-parity debug side channel. The logger itself owns the `--debug`
 * guard and byte-for-byte line formatting.
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
).pipe(Layer.provide(FetchHttpClient.layer));
