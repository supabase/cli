import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Layer, ManagedRuntime } from "effect";
import { Agent } from "undici";

import { makeApiClient, type ApiClient } from "./effect.ts";
import {
  type SupabaseApiClientOptions,
  type SupabaseApiConfig,
  type SupabaseApiConfigError,
  supabaseApiClientLayer,
  SupabaseApiClient,
} from "./internal/client.ts";
import { makePromiseClient, type PromiseClient } from "./internal/promise-client.ts";

const nodeDispatcherLayer = Layer.succeed(
  NodeHttpClient.Dispatcher,
  new Agent({
    connectTimeout: 10_000,
    keepAliveTimeout: 4_000,
  }),
);

const nodeHttpClientLayer = NodeHttpClient.layerUndiciNoDispatcher.pipe(
  Layer.provide(nodeDispatcherLayer),
);

export function clientLayer(
  config: SupabaseApiConfig = {},
  options?: SupabaseApiClientOptions,
): Layer.Layer<SupabaseApiClient, SupabaseApiConfigError> {
  return supabaseApiClientLayer(config, options).pipe(Layer.provide(nodeHttpClientLayer));
}

export async function createApiClient(
  config: SupabaseApiConfig = {},
  options?: SupabaseApiClientOptions,
): Promise<PromiseSupabaseApiClient> {
  const runtime = ManagedRuntime.make(nodeHttpClientLayer);
  const effectClient = await runtime.runPromise(makeApiClient(config, options));
  const { v1, ...unversioned } = effectClient;
  return {
    ...makePromiseClient(runtime, unversioned),
    v1: makePromiseClient(runtime, v1),
  };
}

export type PromiseSupabaseApiClient = PromiseClient<Omit<ApiClient, "v1">> & {
  readonly v1: PromiseClient<ApiClient["v1"]>;
};
export * from "./generated/contracts.ts";
