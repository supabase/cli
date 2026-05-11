import { NodeServices } from "@effect/platform-node";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import * as Http from "node:http";
import { Readable } from "node:stream";
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

const mergeBodyHeaders = (
  headersInit: RequestInit["headers"] | undefined,
  bodyHeaders: Headers,
): Headers => {
  const headers = new Headers(headersInit);
  for (const [key, value] of bodyHeaders.entries()) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  return headers;
};

const toOutgoingHeaders = (headers: Headers): Http.OutgoingHttpHeaders =>
  Object.fromEntries(headers.entries());

const toResponseHeaders = (headers: Http.IncomingHttpHeaders): Headers => {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        responseHeaders.append(key, item);
      }
      continue;
    }
    responseHeaders.set(key, value);
  }
  return responseHeaders;
};

const encodeRequest = async (
  init: RequestInit | undefined,
): Promise<{
  readonly body: Uint8Array | undefined;
  readonly headers: Http.OutgoingHttpHeaders;
}> => {
  if (init?.body == null) {
    return {
      body: undefined,
      headers: toOutgoingHeaders(new Headers(init?.headers)),
    };
  }

  const bodyResponse = new Response(init.body);
  const headers = mergeBodyHeaders(init.headers, bodyResponse.headers);
  return {
    body: new Uint8Array(await bodyResponse.arrayBuffer()),
    headers: toOutgoingHeaders(headers),
  };
};

const toWebResponse = (response: Http.IncomingMessage): Response =>
  new Response(
    response.statusCode === 204 || response.statusCode === 304 ? null : Readable.toWeb(response),
    {
      status: response.statusCode ?? 200,
      statusText: response.statusMessage ?? "",
      headers: toResponseHeaders(response.headers),
    },
  );

export const unixHttpClientLayer = Layer.succeed(UnixHttpClient, {
  request: (socketPath, path, init) =>
    Effect.tryPromise({
      try: async () => {
        const { body, headers } = await encodeRequest(init);
        return await new Promise<Response>((resolve, reject) => {
          const request = Http.request(
            {
              socketPath,
              path,
              method: init?.method ?? "GET",
              headers,
              signal: init?.signal ?? undefined,
            },
            (response) => {
              resolve(toWebResponse(response));
            },
          );

          request.on("error", reject);
          request.end(body);
        });
      },
      catch: (cause) => new UnixHttpClientError({ socketPath, path, cause }),
    }),
});

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

/**
 * If the process was spawned by `forkDaemon` (i.e. `SUPABASE_DAEMON_ENTRYPOINT`
 * is set), run the daemon and resolve when it exits. Otherwise resolve `false`
 * immediately. Used by a compiled CLI entry: when `child_process.fork()`
 * targets a self-contained executable, the script-path argv is ignored, so we
 * dispatch through an env var instead and run the daemon in-process from the
 * same binary.
 */
export async function runDaemonIfRequested(): Promise<boolean> {
  if (!process.env["SUPABASE_DAEMON_ENTRYPOINT"]) return false;
  await runDaemon(
    (apiPort) =>
      Layer.mergeAll(
        NodeServices.layer,
        NodeHttpServer.layer(() => createServer(), { port: apiPort }).pipe(Layer.orDie),
      ),
    (socketPath) =>
      NodeHttpServer.layer(() => createServer(), { path: socketPath }).pipe(Layer.orDie),
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
      Effect.provide(NodeServices.layer),
    ),
  );
}

export * from "./index.ts";
