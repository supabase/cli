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
import { runDaemon } from "./daemon.ts";
import {
  prefetch as prefetchEffect,
  type PrefetchOptions,
  type PrefetchResult,
} from "./prefetch.ts";
import { defaultCacheRoot } from "./paths.ts";
import { StackPreparation } from "./StackPreparation.ts";
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

/**
 * If the process was spawned by `forkDaemon` (i.e. `SUPABASE_DAEMON_ENTRYPOINT`
 * is set), run the daemon and resolve when it exits. Otherwise resolve `false`
 * immediately. Used by a compiled `bun --compile` CLI entry: standalone
 * executables ignore the script-path argv that `child_process.fork()` passes,
 * so we dispatch through an env var instead and run the daemon in-process from
 * the same binary.
 */
export async function runDaemonIfRequested(): Promise<boolean> {
  if (!process.env["SUPABASE_DAEMON_ENTRYPOINT"]) return false;
  await runDaemon(
    (apiPort) => Layer.mergeAll(BunServices.layer, BunHttpServer.layer({ port: apiPort })),
    (socketPath) => BunHttpServer.layer({ idleTimeout: 0, unix: socketPath }),
  );
  return true;
}

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
  const preparationLayer = StackPreparation.layer.pipe(Layer.provide(resolverLayer));
  return Effect.runPromise(
    prefetchEffect(options).pipe(
      Effect.provide(preparationLayer),
      Effect.provide(BunServices.layer),
    ),
  );
}

export * from "./index.ts";
