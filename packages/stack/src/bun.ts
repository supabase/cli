import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { homedir } from "node:os";
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
import type { StackConfig } from "./StackBuilder.ts";

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
  const home = `${homedir()}/.supabase`;
  const resolverLayer = BinaryResolver.make(home).pipe(Layer.provide(FetchHttpClient.layer));
  return Effect.runPromise(
    prefetchEffect(options).pipe(Effect.provide(resolverLayer), Effect.provide(BunServices.layer)),
  );
}

export type { PlatformFactory, PlatformLayer, StackHandle } from "./createStack.ts";
export type { PrefetchOptions, PrefetchResult } from "./prefetch.ts";
export type { ServiceResolution } from "./resolve.ts";
export type { AuthConfig, PostgresConfig, PostgrestConfig, StackConfig } from "./StackBuilder.ts";
export type { VersionManifest } from "./versions.ts";
