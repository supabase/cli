import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BinaryResolver } from "./BinaryResolver.ts";
import {
  createStack as createStackCore,
  type PlatformFactory,
  type StackHandle,
} from "./createStack.ts";
import {
  prefetch as prefetchEffect,
  type PrefetchOptions,
  type PrefetchResult,
} from "./prefetch.ts";
import { defaultCacheRoot } from "./paths.ts";
import type { StackConfig } from "./StackBuilder.ts";
import { UnixHttpClient, UnixHttpClientError } from "./UnixHttpClient.ts";

interface BunUnixRequestInit extends RequestInit {
  readonly unix: string;
}

export const unixHttpClientLayer = Layer.succeed(UnixHttpClient, {
  request: (socketPath, path, init) =>
    Effect.tryPromise({
      try: () => {
        const requestInit: BunUnixRequestInit = {
          ...init,
          unix: socketPath,
        };
        return fetch(`http://localhost${path}`, requestInit);
      },
      catch: (cause) => new UnixHttpClientError({ socketPath, path, cause }),
    }),
});

// ---------------------------------------------------------------------------
// Platform values — for use with Effect layer factories
// ---------------------------------------------------------------------------

/** Bun platform factory for use with foregroundLayer / daemonLayer. */
export const platformFactory: PlatformFactory = (apiPort) =>
  Layer.mergeAll(BunServices.layer, BunHttpServer.layer({ port: apiPort }));

/** Path to the Bun daemon entry point for use with daemonLayer. */
export const daemonEntryPoint: string = fileURLToPath(new URL("./daemon-bun.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Promise API — convenience wrappers for non-Effect consumers
// ---------------------------------------------------------------------------

export async function createStack(config?: StackConfig): Promise<StackHandle> {
  return createStackCore(config, platformFactory);
}

export async function prefetch(options?: PrefetchOptions): Promise<PrefetchResult> {
  const resolverLayer = BinaryResolver.make(defaultCacheRoot()).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
  return Effect.runPromise(
    prefetchEffect(options).pipe(Effect.provide(resolverLayer), Effect.provide(BunServices.layer)),
  );
}

export * from "./index.ts";
