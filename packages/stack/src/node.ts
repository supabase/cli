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
import {
  resolveConfig as resolveConfigEffect,
  type ResolveConfigOptions,
} from "./StackConfigResolver.ts";

const resolveConfigEffectForPlatform: ResolveConfigEffect = (config, options) =>
  resolveConfigEffect(config, options);

const resolveConfigPromise = (config?: StackConfig, options?: ResolveConfigOptions) =>
  Effect.runPromise(resolveConfigEffect(config, options).pipe(Effect.provide(NodeServices.layer)));

/**
 * The Node daemon bootstrap is deliberately not exported from the package. The conditional Effect
 * entry resolves `daemon-node.ts` by file URL through the internal platform adapter. Keep
 * `src/daemon-node.ts` in package.json's `knip.entry` list: static imports cannot see that fork target.
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

export async function resolveConfig(config?: StackConfig, options?: ResolveConfigOptions) {
  return resolveConfigPromise(config, options);
}

export async function prefetch(options?: PrefetchOptions): Promise<PrefetchResult> {
  const runtime = await Effect.runPromise(
    selectStackRuntime(options?.mode).pipe(Effect.provide(NodeServices.layer)),
  ).catch((error: unknown) => {
    throw toStackError(error);
  });
  const resolverLayer = BinaryResolver.make(defaultCacheRoot()).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
  const preparationLayer = StackPreparation.layer.pipe(Layer.provide(resolverLayer));
  const resolvedOptions: PrefetchEffectOptions =
    runtime.mode === "native"
      ? { ...options, mode: "native" }
      : { ...options, mode: "docker", containerRuntime: runtime.containerRuntime };
  return Effect.runPromise(
    prefetchEffect(resolvedOptions).pipe(
      Effect.provide(preparationLayer),
      Effect.provide(NodeServices.layer),
    ),
  );
}

export * from "./index.ts";
