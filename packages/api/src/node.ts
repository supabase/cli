import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Undici from "@effect/platform-node/Undici";
import { Effect, Layer, ManagedRuntime } from "effect";

import { makeApiClient, type ApiClient } from "./effect.ts";
import { type SupabaseApiClientOptions, type SupabaseApiConfig } from "./internal/client.ts";
import { makePromiseClient, type PromiseClient } from "./internal/promise-client.ts";

const nodeDispatcherLayer = Layer.effect(NodeHttpClient.Dispatcher)(
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new Undici.Agent({
          connectTimeout: 10_000,
          keepAliveTimeout: 4_000,
        }),
    ),
    (dispatcher) => Effect.promise(() => dispatcher.destroy()),
  ),
);

const nodeHttpClientLayer = NodeHttpClient.layerUndiciNoDispatcher.pipe(
  Layer.provide(nodeDispatcherLayer),
);

/** Creates a Promise API client backed by a scoped Node HTTP dispatcher. */
export async function createApiClient(
  config: SupabaseApiConfig = {},
  options?: SupabaseApiClientOptions,
): Promise<PromiseSupabaseApiClient> {
  const runtime = ManagedRuntime.make(nodeHttpClientLayer);
  try {
    const effectClient = await runtime.runPromise(makeApiClient(config, options));
    return makePromiseClient(runtime, effectClient);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

/** Promise API client whose runtime and HTTP dispatcher are released by `dispose`. */
export type PromiseSupabaseApiClient = PromiseClient<ApiClient>;
export * from "./generated/contracts.ts";
