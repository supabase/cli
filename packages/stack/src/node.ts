import { NodeServices } from "@effect/platform-node";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
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

// ---------------------------------------------------------------------------
// Platform values — for use with Effect layer factories
// ---------------------------------------------------------------------------

/** Node platform factory for use with foregroundLayer / daemonLayer. */
export const platformFactory: PlatformFactory = (apiPort) =>
  Layer.mergeAll(
    NodeServices.layer,
    NodeHttpServer.layer(() => createServer(), { port: apiPort }).pipe(Layer.orDie),
  );

/** Path to the Node daemon entry point for use with daemonLayer. */
export const daemonEntryPoint: string = fileURLToPath(new URL("./daemon-node.ts", import.meta.url));

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
    prefetchEffect(options).pipe(Effect.provide(resolverLayer), Effect.provide(NodeServices.layer)),
  );
}

export * from "./index.ts";
