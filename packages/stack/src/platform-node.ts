import { NodeServices } from "@effect/platform-node";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import * as Http from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import type { PlatformFactory } from "./createStack.ts";
import {
  CONTROL_STATUS_PATH,
  ControlBindError,
  ControlProtocolError,
  ControlTransport,
  ControlTransportError,
  type ControlOwnerStatus,
  type ControlEndpoint,
} from "./managed/control.ts";
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
              ...(typeof socketPath === "string"
                ? { socketPath }
                : { hostname: socketPath.hostname, port: socketPath.port }),
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

const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return errorCode(cause.cause);
  return undefined;
};

const closeControlServer = (server: Http.Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return Effect.void;
    }
    server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)));
    return Effect.void;
  });

const controlTransport: ControlTransport["Service"] = {
  bind: (endpoint: ControlEndpoint, ownerStatus: () => ControlOwnerStatus) => {
    const rawServer = createServer((request, response) => {
      if (request.url !== CONTROL_STATUS_PATH || request.method !== "GET") return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(ownerStatus()));
    });
    return NodeHttpServer.make(() => rawServer, {
      host: endpoint.hostname,
      port: endpoint.port,
      disablePreemptiveShutdown: true,
    }).pipe(
      Effect.map((server) => ({ server, close: closeControlServer(rawServer) })),
      Effect.mapError(
        (cause) =>
          new ControlBindError({
            endpoint,
            reason: errorCode(cause) === "EADDRINUSE" ? "in-use" : "failed",
            cause,
          }),
      ),
    );
  },
  read: (endpoint: ControlEndpoint) =>
    Effect.tryPromise({
      try: async () => {
        const requestStatus = (host: string) =>
          new Promise<unknown>((resolve, reject) => {
            const request = Http.request(
              {
                host,
                port: endpoint.port,
                path: CONTROL_STATUS_PATH,
                method: "GET",
              },
              (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                  body += chunk;
                });
                response.on("end", () => {
                  if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
                    reject(
                      new Error(`Control status request returned ${response.statusCode ?? 500}`),
                    );
                    return;
                  }
                  try {
                    resolve(JSON.parse(body));
                  } catch (cause) {
                    reject(cause);
                  }
                });
              },
            );
            request.setTimeout(25, () =>
              request.destroy(new Error("Control status request timed out")),
            );
            request.once("error", reject);
            request.end();
          });
        return await requestStatus("127.0.0.1");
      },
      catch: (cause) => {
        const code = errorCode(cause);
        if (
          code === "ECONNREFUSED" ||
          code === "ECONNRESET" ||
          code === "EHOSTUNREACH" ||
          (cause instanceof Error && cause.message === "Control status request timed out")
        ) {
          return new ControlTransportError({ endpoint, reason: "unreachable", cause });
        }
        if (
          cause instanceof SyntaxError ||
          (cause instanceof Error &&
            cause.message.startsWith("Control status request returned") &&
            !cause.message.endsWith(" 404"))
        ) {
          return new ControlProtocolError({ endpoint, cause });
        }
        if (cause instanceof Error && cause.message.endsWith(" 404")) {
          return new ControlTransportError({ endpoint, reason: "unreachable", cause });
        }
        return new ControlTransportError({ endpoint, reason: "transport", cause });
      },
    }),
};

export const controlTransportLayer = Layer.succeed(ControlTransport, controlTransport);

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
