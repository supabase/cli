// oxlint-disable effecttsgo/async-function, effecttsgo/multiple-effect-provide -- Public Node Promise facades intentionally bridge host async calls; platform and transport layers are staged to preserve dependency and scope ordering.

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BinaryResolver } from "./BinaryResolver.ts";
import { selectStackRuntime } from "./ContainerRuntime.ts";
import { createStack as createStackCore, type ResolveConfigEffect } from "./createStack.ts";
import { toStackHandle, type StackHandle } from "./stackHandle.ts";
import { toStackError } from "./errors.ts";
import {
  prefetch as prefetchEffect,
  type PrefetchEffectOptions,
  type PrefetchOptions,
  type PrefetchResult,
} from "./prefetch.ts";
import { defaultCacheRoot } from "./paths.ts";
import { platformFactory } from "./platform-node.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { StackConfig } from "./StackConfig.ts";
import { resolveConfig as resolveConfigEffect } from "./StackConfigResolver.ts";

const resolveConfigEffectForPlatform: ResolveConfigEffect = (config, options) =>
  resolveConfigEffect(config, options);

/**
 * The Node daemon bootstrap is deliberately not exported from the package. The conditional Effect
 * entry resolves `daemon-node.ts` by file URL through the internal platform adapter. Keep
 * `src/daemon-node.ts` in the `packages/stack` workspace entry in the root `knip.json`: static
 * imports cannot see that fork target.
 */

export async function createStack(config?: StackConfig): Promise<StackHandle> {
  const runtime = await Effect.runPromise(
    selectStackRuntime(config?.mode).pipe(Effect.provide(NodeServices.layer)),
  ).catch((error: unknown) => {
    throw toStackError(error);
  });
  const handle = await Effect.runPromise(
    createStackCore(config, platformFactory, runtime, resolveConfigEffectForPlatform).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  return toStackHandle(handle);
}

export async function prefetch(options?: PrefetchOptions): Promise<PrefetchResult> {
  const runtime = await Effect.runPromise(
    selectStackRuntime(options?.mode).pipe(Effect.provide(NodeServices.layer)),
  ).catch((error: unknown) => {
    throw toStackError(error);
  });
  const resolverLayer = BinaryResolver.make(options?.cacheRoot ?? defaultCacheRoot()).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
  const preparationLayer = StackPreparation.layer.pipe(Layer.provide(resolverLayer));
  const effectOptions = {
    versions: options?.versions,
    services: options?.services,
    enabledServices: options?.enabledServices,
  };
  const resolvedOptions: PrefetchEffectOptions =
    runtime.mode === "native"
      ? { ...effectOptions, mode: "native" }
      : { ...effectOptions, mode: "docker", containerRuntime: runtime.containerRuntime };
  return Effect.runPromise(
    prefetchEffect(resolvedOptions).pipe(
      Effect.provide(preparationLayer),
      Effect.provide(NodeServices.layer),
    ),
  );
}

export * from "./index.ts";
