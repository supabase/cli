import { NodeServices } from "@effect/platform-node";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import * as Http from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import type { PlatformFactory } from "./createStack.ts";
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
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(key, item);
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
      catch: (cause) => new UnixHttpClientError({ socketPath, path, cause, reason: "transport" }),
    }),
});

export const platformFactory: PlatformFactory = ({ apiPort, releaseApiPort }) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.unwrap(
      releaseApiPort.pipe(
        Effect.as(NodeHttpServer.layer(() => createServer(), { port: apiPort }).pipe(Layer.orDie)),
      ),
    ),
  );

/** Internal child-process target. It is intentionally absent from package exports. */
export const daemonEntryPoint = fileURLToPath(new URL("./daemon-node.ts", import.meta.url));
