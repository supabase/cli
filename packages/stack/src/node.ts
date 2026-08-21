import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BinaryResolver } from "./BinaryResolver.ts";
import { createStack as createStackCore } from "./createStack.ts";
import { toStackHandle, type StackHandle } from "./stackHandle.ts";
import {
  prefetch as prefetchEffect,
  type PrefetchOptions,
  type PrefetchResult,
} from "./prefetch.ts";
import { defaultCacheRoot } from "./paths.ts";
import { platformFactory } from "./platform-node.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { StackConfig } from "./StackConfig.ts";

/**
 * The Node daemon bootstrap is deliberately not exported from the package. The conditional Effect
 * entry resolves `daemon-node.ts` by file URL through the internal platform adapter. Keep
 * `src/daemon-node.ts` in package.json's `knip.entry` list: static imports cannot see that fork target.
 */

export async function createStack(config?: StackConfig): Promise<StackHandle> {
  return toStackHandle(
    await Effect.runPromise(
      createStackCore(config, platformFactory).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
}

export async function prefetch(options?: PrefetchOptions): Promise<PrefetchResult> {
  const resolverLayer = BinaryResolver.make(defaultCacheRoot()).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
  const preparationLayer = StackPreparation.layer.pipe(Layer.provide(resolverLayer));
  return Effect.runPromise(
    prefetchEffect(options).pipe(
      Effect.provide(preparationLayer),
      Effect.provide(NodeServices.layer),
    ),
  );
}

export * from "./index.ts";
