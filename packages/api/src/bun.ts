import { BunServices } from "@effect/platform-bun";
import { Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { makeApiClient, type ApiClient } from "./effect.ts";
import { type SupabaseApiClientOptions, type SupabaseApiConfig } from "./internal/client.ts";
import { makePromiseClient, type PromiseClient } from "./internal/promise-client.ts";

/** Creates a Promise API client backed by a managed Bun runtime. */
export async function createApiClient(
  config: SupabaseApiConfig = {},
  options?: SupabaseApiClientOptions,
): Promise<PromiseSupabaseApiClient> {
  const runtime = ManagedRuntime.make(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer));
  try {
    const effectClient = await runtime.runPromise(makeApiClient(config, options));
    return makePromiseClient(runtime, effectClient);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

/** Promise API client whose runtime resources are released by `dispose`. */
export type PromiseSupabaseApiClient = PromiseClient<ApiClient>;
export * from "./generated/contracts.ts";
