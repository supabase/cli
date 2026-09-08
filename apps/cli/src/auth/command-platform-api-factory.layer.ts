import { FetchHttpClient } from "effect/unstable/http";
import { Effect, Layer } from "effect";

import { dohFetchLayer } from "../command-internal/http-dns.ts";
import { makeCommandPlatformApi } from "./command-platform-api.layer.ts";
import { CommandPlatformApi } from "./command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "./command-platform-api-factory.service.ts";

type CommandPlatformApiDeps =
  typeof makeCommandPlatformApi extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

/**
 * Captures the surrounding Management API context without resolving an access
 * token. The raw fetch client is provided here so `makeCommandPlatformApi` owns
 * the single typed-API debug wrapper.
 *
 * `dohFetchLayer` overrides `FetchHttpClient.Fetch` so that when the
 * factory's `make` resolves on the `--linked` path, the typed API client
 * honours `--dns-resolver https`.
 */
export const commandPlatformApiFactoryLayer = Layer.effect(
  CommandPlatformApiFactory,
  Effect.gen(function* () {
    const context = yield* Effect.context<CommandPlatformApiDeps>();
    const make = yield* makeCommandPlatformApi.pipe(Effect.provideContext(context), Effect.cached);

    return CommandPlatformApiFactory.of({
      make,
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(dohFetchLayer));

/**
 * Adapts an already-built eager `CommandPlatformApi` into a factory. Use this in
 * runtimes that intentionally require Management API auth up front but still
 * need to satisfy services that consume the lazy factory shape.
 */
export const commandPlatformApiFactoryFromApiLayer = Layer.effect(
  CommandPlatformApiFactory,
  CommandPlatformApi.pipe(
    Effect.map((api) =>
      CommandPlatformApiFactory.of({
        make: Effect.succeed(api),
      }),
    ),
  ),
);
