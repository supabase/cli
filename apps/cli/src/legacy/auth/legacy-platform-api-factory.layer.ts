import { FetchHttpClient } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { legacyDohFetchLayer } from "../shared/legacy-http-dns.ts";
import { legacyMakePlatformApi } from "./legacy-platform-api.layer.ts";
import { LegacyPlatformApi } from "./legacy-platform-api.service.ts";
import { LegacyPlatformApiFactory } from "./legacy-platform-api-factory.service.ts";

type LegacyPlatformApiDeps =
  typeof legacyMakePlatformApi extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

/**
 * Captures the surrounding Management API context without resolving an access
 * token. The raw fetch client is provided here so `legacyMakePlatformApi` owns
 * the single typed-API debug wrapper.
 *
 * `legacyDohFetchLayer` overrides `FetchHttpClient.Fetch` so that when the
 * factory's `make` resolves on the `--linked` path, the typed API client
 * honours `--dns-resolver https` — mirroring Go's `withFallbackDNS` hook.
 */
export const legacyPlatformApiFactoryLayer = Layer.effect(
  LegacyPlatformApiFactory,
  Effect.gen(function* () {
    const context = yield* Effect.context<LegacyPlatformApiDeps>();
    const make = yield* legacyMakePlatformApi.pipe(Effect.provideContext(context), Effect.cached);

    return LegacyPlatformApiFactory.of({
      make,
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(legacyDohFetchLayer));

/**
 * Adapts an already-built eager `LegacyPlatformApi` into a factory. Use this in
 * runtimes that intentionally require Management API auth up front but still
 * need to satisfy services that consume the lazy factory shape.
 */
export const legacyPlatformApiFactoryFromApiLayer = Layer.effect(
  LegacyPlatformApiFactory,
  LegacyPlatformApi.pipe(
    Effect.map((api) =>
      LegacyPlatformApiFactory.of({
        make: Effect.succeed(api),
      }),
    ),
  ),
);
