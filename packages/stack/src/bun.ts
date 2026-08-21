import { BunServices } from "@effect/platform-bun";
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
import { platformFactory } from "./platform-bun.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { StackConfig } from "./StackConfig.ts";

export async function createStack(config?: StackConfig): Promise<StackHandle> {
  return toStackHandle(
    await Effect.runPromise(
      createStackCore(config, platformFactory).pipe(Effect.provide(BunServices.layer)),
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
      Effect.provide(BunServices.layer),
    ),
  );
}

export * from "./index.ts";
