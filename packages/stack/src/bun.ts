// oxlint-disable effecttsgo/async-function, effecttsgo/multiple-effect-provide -- Public Bun Promise facades intentionally bridge host async calls; platform and transport layers are staged to preserve dependency and scope ordering.

import { BunServices } from "@effect/platform-bun";
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
import { platformFactory } from "./platform-bun.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { StackConfig } from "./StackConfig.ts";
import { resolveConfig as resolveConfigEffect } from "./StackConfigResolver.ts";

const resolveConfigEffectForPlatform: ResolveConfigEffect = (config, options) =>
  resolveConfigEffect(config, options);

export async function createStack(config?: StackConfig): Promise<StackHandle> {
  const runtime = await Effect.runPromise(
    selectStackRuntime(config?.mode).pipe(Effect.provide(BunServices.layer)),
  ).catch((error: unknown) => {
    throw toStackError(error);
  });
  const handle = await Effect.runPromise(
    createStackCore(config, platformFactory, runtime, resolveConfigEffectForPlatform).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
  return toStackHandle(handle);
}

export async function prefetch(options?: PrefetchOptions): Promise<PrefetchResult> {
  const runtime = await Effect.runPromise(
    selectStackRuntime(options?.mode).pipe(Effect.provide(BunServices.layer)),
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
      Effect.provide(BunServices.layer),
    ),
  );
}

export * from "./index.ts";
