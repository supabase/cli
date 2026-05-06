import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Undici from "@effect/platform-node/Undici";
import { Layer, ManagedRuntime } from "effect";

import { makeApiClient, type ApiClient } from "./effect.ts";
import { type SupabaseApiClientOptions, type SupabaseApiConfig } from "./internal/client.ts";
import { makePromiseClient, type PromiseClient } from "./internal/promise-client.ts";

const nodeDispatcherLayer = Layer.succeed(
  NodeHttpClient.Dispatcher,
  new Undici.Agent({
    connectTimeout: 10_000,
    keepAliveTimeout: 4_000,
  }),
);

const nodeHttpClientLayer = NodeHttpClient.layerUndiciNoDispatcher.pipe(
  Layer.provide(nodeDispatcherLayer),
);

export async function createApiClient(
  config: SupabaseApiConfig = {},
  options?: SupabaseApiClientOptions,
): Promise<PromiseSupabaseApiClient> {
  const runtime = ManagedRuntime.make(nodeHttpClientLayer);
  const effectClient = await runtime.runPromise(makeApiClient(config, options));
  return makePromiseClient(runtime, effectClient);
}

export type PromiseSupabaseApiClient = PromiseClient<ApiClient>;
export * from "./generated/contracts.ts";
