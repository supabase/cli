import { Deferred, Effect, Layer, Option, Context, Queue, Schedule, Result } from "effect";
import { Buffer } from "node:buffer";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import { ProxyWebSocketConnector } from "./ProxyWebSocket.ts";
import { StackServiceActivator } from "./ServiceActivation.ts";
import type { ServiceName } from "./versions.ts";

export interface ProxyConfig {
  readonly listenPort: number;
  readonly gotruePort: number;
  readonly postgrestPort: number;
  readonly postgrestAdminPort: number;
  readonly edgeRuntimePort: number;
  readonly realtimePort: number;
  readonly realtimeTenantId: string;
  readonly storagePort: number;
  readonly pgmetaPort: number;
  readonly analyticsPort: number;
  readonly poolerPort: number;
  readonly studioPort: number;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
}

function transformAuthorization(
  headers: Headers.Headers,
  config: ProxyConfig,
  useCustomHeader = false,
): Headers.Headers {
  const auth = headers["authorization"];
  const apikey = headers["apikey"];

  const transformHeaderName = useCustomHeader ? "sb-api-key" : "authorization";
  const transformPrefix = useCustomHeader ? "" : "Bearer ";

  if (auth !== undefined && !auth.startsWith("Bearer sb_")) {
    return headers;
  }

  if (apikey === config.publishableKey) {
    return Headers.set(headers, transformHeaderName, transformPrefix + config.anonJwt);
  }
  if (apikey === config.secretKey) {
    return Headers.set(headers, transformHeaderName, transformPrefix + config.serviceRoleJwt);
  }
  if (apikey !== undefined && apikey !== "") {
    return Headers.set(headers, transformHeaderName, apikey);
  }

  return headers;
}

function addProxyHeaders(
  headers: Headers.Headers,
  remoteAddress: string | undefined,
): Headers.Headers {
  const clientIp = remoteAddress ?? "127.0.0.1";
  const prior = headers["x-forwarded-for"];
  const xForwardedFor = prior !== undefined ? `${prior}, ${clientIp}` : clientIp;

  return Headers.set(
    Headers.set(Headers.set(headers, "x-real-ip", clientIp), "x-forwarded-for", xForwardedFor),
    "x-forwarded-proto",
    "http",
  );
}

const STRIP_PROXY_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "date",
  "transfer-encoding",
]);

function sanitizeProxyResponseHeaders(headers: Headers.Headers): Headers.Headers {
  return Headers.fromInput(
    Object.fromEntries(
      Object.entries(headers).filter(
        ([name]) => !STRIP_PROXY_RESPONSE_HEADERS.has(name.toLowerCase()),
      ),
    ),
  );
}

const CORS_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["access-control-allow-origin", "*"],
  ["access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS"],
  ["access-control-allow-headers", "Authorization, Content-Type, apikey, X-Client-Info"],
  ["access-control-expose-headers", "Content-Range, Range, sb-error-code"],
  ["access-control-max-age", "86400"],
];

function addCorsHeaders(
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse {
  return CORS_HEADERS.reduce(
    (res, [name, value]) => HttpServerResponse.setHeader(res, name, value),
    response,
  );
}

// Edge Functions cold-boot lazily: the first request to a function makes the
// edge-runtime spin up a user worker, and it can drop the connection while it
// does so. Its `/_internal/health` probe answers immediately, so "Healthy"
// status does not mean a function is servable yet. Briefly retry transport
// failures on that route so a user's first call doesn't surface as a 502.
const COLD_START_RETRY_SCHEDULE = Schedule.spaced("250 millis").pipe(Schedule.upTo({ times: 8 }));

interface ProxyHandlerOptions {
  readonly service: ServiceName;
  readonly backendPort: number;
  readonly stripPrefix?: string;
  readonly backendPath?: string;
  readonly transformAuth?: boolean;
  readonly transformAuthCustomHeader?: boolean;
  readonly extraHeaders?: Record<string, string>;
  // Retry transient transport failures, for backends (edge-runtime) that may
  // refuse/reset connections while cold-starting. Buffers the request body so
  // it can be re-sent across attempts.
  readonly retryColdStart?: boolean;
}

function makeProxyHandler(
  client: HttpClient.HttpClient,
  config: ProxyConfig,
  activator: StackServiceActivator["Service"],
  opts: ProxyHandlerOptions,
) {
  return (req: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const activation = yield* Effect.result(activator.activate(opts.service));
      if (Result.isFailure(activation)) {
        return HttpServerResponse.text("Service unavailable", {
          status: 503,
          headers: { "retry-after": "1" },
        });
      }

      let backendPath = opts.backendPath;

      if (backendPath === undefined) {
        backendPath = req.url.startsWith(opts.stripPrefix ?? "")
          ? req.url.slice((opts.stripPrefix ?? "").length)
          : req.url;
        if (backendPath === "") {
          backendPath = "/";
        }
      }

      let outHeaders = req.headers;
      if (opts.transformAuth === true) {
        outHeaders = transformAuthorization(outHeaders, config, opts.transformAuthCustomHeader);
      }
      outHeaders = addProxyHeaders(outHeaders, Option.getOrUndefined(req.remoteAddress));

      for (const [name, value] of Object.entries(opts.extraHeaders ?? {})) {
        outHeaders = Headers.set(outHeaders, name, value);
      }

      const backendUrl = `http://127.0.0.1:${opts.backendPort}${backendPath}`;
      const noBodyMethods = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
      const contentType = Option.getOrUndefined(Headers.get(req.headers, "content-type"));

      let body: HttpBody.HttpBody;
      if (noBodyMethods.has(req.method)) {
        body = HttpBody.empty;
      } else if (opts.retryColdStart === true) {
        // Buffer the body so the request can be safely re-sent if we retry.
        const buffered = yield* Effect.result(req.arrayBuffer);
        if (Result.isFailure(buffered)) {
          return HttpServerResponse.text("Bad gateway: unable to read request body", {
            status: 502,
          });
        }
        body = HttpBody.uint8Array(new Uint8Array(buffered.success), contentType);
      } else {
        body = HttpBody.stream(req.stream, contentType);
      }

      const outReq = HttpClientRequest.make(req.method)(backendUrl, {
        headers: outHeaders,
        body,
      });

      const request = client.execute(outReq);
      const outRes = yield* opts.retryColdStart === true
        ? Effect.retry(request, {
            while: (error) => error.reason._tag === "TransportError",
            schedule: COLD_START_RETRY_SCHEDULE,
          })
        : request;
      const responseHeaders = sanitizeProxyResponseHeaders(outRes.headers);
      return HttpServerResponse.stream(outRes.stream, {
        status: outRes.status,
        headers: responseHeaders,
      });
    }).pipe(
      Effect.catchTag("HttpClientError", (error) =>
        Effect.succeed(
          HttpServerResponse.text(`Bad gateway: ${error.message}`, {
            status: 502,
          }),
        ),
      ),
    );
}

const realtimeWebSocketBackendUrl = (requestUrl: string, config: ProxyConfig): string => {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const apiKey = url.searchParams.get("apikey");
  if (apiKey === config.publishableKey) {
    url.searchParams.set("apikey", config.anonJwt);
  } else if (apiKey === config.secretKey) {
    url.searchParams.set("apikey", config.serviceRoleJwt);
  }
  const strippedPath = url.pathname.startsWith("/realtime/v1")
    ? url.pathname.slice("/realtime/v1".length)
    : url.pathname;
  url.pathname = `/socket${strippedPath === "" ? "/websocket" : strippedPath}`;
  return `ws://127.0.0.1:${config.realtimePort}${url.pathname}${url.search}`;
};

const webSocketProtocols = (headers: Headers.Headers): ReadonlyArray<string> | undefined => {
  const value = headers["sec-websocket-protocol"];
  if (value === undefined) {
    return undefined;
  }
  const protocols = value
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
  // Both proxy legs use their default first-match negotiation. Forwarding only
  // the first offer guarantees that the upstream selection is the protocol
  // already selected by the downstream server.
  return protocols.length === 0 ? undefined : protocols.slice(0, 1);
};

const WEB_SOCKET_PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const hasValidWebSocketProtocols = (value: string | undefined): boolean => {
  if (value === undefined) return true;
  const protocols = value.split(",").map((protocol) => protocol.trim());
  return (
    protocols.length > 0 &&
    protocols.every((protocol) => WEB_SOCKET_PROTOCOL_TOKEN.test(protocol)) &&
    new Set(protocols).size === protocols.length
  );
};

export const isWebSocketUpgradeRequest = (
  method: string,
  headers: Readonly<Record<string, string | undefined>>,
): boolean => {
  const connectionTokens = (headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase());
  const key = headers["sec-websocket-key"];
  const validKey =
    key !== undefined &&
    /^[A-Za-z0-9+/]{22}==$/.test(key) &&
    Buffer.from(key, "base64").byteLength === 16;
  return (
    method === "GET" &&
    connectionTokens.includes("upgrade") &&
    headers.upgrade?.toLowerCase() === "websocket" &&
    validKey &&
    headers["sec-websocket-version"] === "13" &&
    hasValidWebSocketProtocols(headers["sec-websocket-protocol"])
  );
};

function makeRealtimeWebSocketHandler(
  config: ProxyConfig,
  activator: StackServiceActivator["Service"],
  connector: ProxyWebSocketConnector["Service"],
) {
  return (req: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      if (!isWebSocketUpgradeRequest(req.method, req.headers)) {
        return HttpServerResponse.text("WebSocket upgrade required", { status: 426 });
      }

      const activation = yield* Effect.result(activator.activate("realtime"));
      if (Result.isFailure(activation)) {
        return HttpServerResponse.text("Service unavailable", {
          status: 503,
          headers: { "retry-after": "1" },
        });
      }

      const connection = yield* Effect.result(
        connector.connect({
          url: realtimeWebSocketBackendUrl(req.url, config),
          host: config.realtimeTenantId,
          protocols: webSocketProtocols(req.headers),
        }),
      );
      if (Result.isFailure(connection)) {
        return HttpServerResponse.text("Bad gateway: unable to connect to Realtime", {
          status: 502,
        });
      }

      const upstream = connection.success;
      return yield* Effect.gen(function* () {
        const upstreamDone = yield* Deferred.make<void>();
        const downstreamQueue = yield* Queue.bounded<Uint8Array | string | Socket.CloseEvent>(64);
        let upstreamFinished = false;
        let downstreamOverflowed = false;
        const forward = (chunk: Uint8Array | string | Socket.CloseEvent) => {
          if (!Queue.offerUnsafe(downstreamQueue, chunk)) {
            downstreamOverflowed = true;
            upstream.close();
          }
        };
        const finish = (event: Socket.CloseEvent) => {
          if (upstreamFinished) return;
          upstreamFinished = true;
          const downstreamEvent =
            event.code === 1005
              ? new Socket.CloseEvent(1000, event.reason)
              : event.code === 1006
                ? new Socket.CloseEvent(1011, event.reason || "Realtime disconnected abnormally")
                : event;
          if (!Queue.offerUnsafe(downstreamQueue, downstreamEvent)) {
            downstreamOverflowed = true;
          }
        };
        // The upstream can emit immediately after connect resolves. Register
        // listeners before awaiting the downstream upgrade and buffer until its
        // writer is available so those first frames and close events are kept.
        const removeMessage = upstream.onMessage(forward);
        const removeClose = upstream.onClose((code, reason) => {
          finish(new Socket.CloseEvent(code, reason));
        });
        const removeError = upstream.onError(() => {
          finish(new Socket.CloseEvent(1011, "Realtime connection failed"));
        });

        return yield* Effect.gen(function* () {
          const upgraded = yield* Effect.result(req.upgrade);
          if (Result.isFailure(upgraded)) {
            return HttpServerResponse.text("WebSocket upgrade required", { status: 426 });
          }

          const downstream = upgraded.success;
          const writeDownstream = yield* downstream.writer;
          const downstreamOpened = yield* Deferred.make<void>();
          const upstreamQueue = yield* Queue.bounded<string | Uint8Array>(64);
          yield* Effect.forkScoped(
            Deferred.await(downstreamOpened).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  while (true) {
                    const chunk = yield* Queue.take(downstreamQueue);
                    yield* writeDownstream(chunk).pipe(Effect.ignore);
                    if (chunk instanceof Socket.CloseEvent) {
                      yield* Deferred.succeed(upstreamDone, undefined);
                      return;
                    }
                    if (downstreamOverflowed) {
                      yield* writeDownstream(
                        new Socket.CloseEvent(1011, "Realtime downstream backpressure exceeded"),
                      ).pipe(Effect.ignore);
                      yield* Deferred.succeed(upstreamDone, undefined);
                      return;
                    }
                  }
                }),
              ),
            ),
          );
          yield* Effect.forkScoped(
            Effect.gen(function* () {
              while (true) {
                yield* upstream.send(yield* Queue.take(upstreamQueue));
              }
            }).pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  upstream.close(1011, "Realtime upstream write failed");
                }),
              ),
            ),
          );
          const onDownstreamOpen = Deferred.succeed(downstreamOpened, undefined);
          const forwardUpstream = (data: string | Uint8Array) =>
            Effect.sync(() => {
              if (!Queue.offerUnsafe(upstreamQueue, data)) {
                upstream.close(1011, "Realtime upstream backpressure exceeded");
              }
            });

          yield* Effect.raceFirst(
            downstream.runRaw(forwardUpstream, { onOpen: onDownstreamOpen }),
            Deferred.await(upstreamDone),
          ).pipe(Effect.catch(() => Effect.void));

          return HttpServerResponse.empty();
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              removeMessage();
              removeClose();
              removeError();
            }),
          ),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            upstream.close();
          }),
        ),
      );
    });
}

export class ApiProxy extends Context.Service<
  ApiProxy,
  {
    readonly address: HttpServer.Address;
  }
>()("local/ApiProxy") {
  static layer = (
    config: ProxyConfig,
  ): Layer.Layer<
    ApiProxy,
    never,
    HttpServer.HttpServer | HttpClient.HttpClient | StackServiceActivator | ProxyWebSocketConnector
  > =>
    Layer.effect(ApiProxy)(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const client = yield* HttpClient.HttpClient;
        const activator = yield* StackServiceActivator;
        const webSocketConnector = yield* ProxyWebSocketConnector;

        const routes = [
          HttpRouter.route("*", "/health", HttpServerResponse.text("OK", { status: 200 })),
          HttpRouter.route(
            "*",
            "/realtime/v1/websocket",
            makeRealtimeWebSocketHandler(config, activator, webSocketConnector),
          ),
          HttpRouter.route(
            "*",
            "/.well-known/oauth-authorization-server",
            makeProxyHandler(client, config, activator, {
              service: "auth",
              backendPort: config.gotruePort,
              backendPath: "/.well-known/oauth-authorization-server",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/verify",
            makeProxyHandler(client, config, activator, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/callback",
            makeProxyHandler(client, config, activator, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/authorize",
            makeProxyHandler(client, config, activator, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/*",
            makeProxyHandler(client, config, activator, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/rest/v1/*",
            makeProxyHandler(client, config, activator, {
              service: "postgrest",
              backendPort: config.postgrestPort,
              stripPrefix: "/rest/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/rest-admin/v1/*",
            makeProxyHandler(client, config, activator, {
              service: "postgrest",
              backendPort: config.postgrestAdminPort,
              stripPrefix: "/rest-admin/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/graphql/v1",
            makeProxyHandler(client, config, activator, {
              service: "postgrest",
              backendPort: config.postgrestPort,
              backendPath: "/rpc/graphql",
              transformAuth: true,
              extraHeaders: { "content-profile": "graphql_public" },
            }),
          ),
          HttpRouter.route(
            "*",
            "/functions/v1/*",
            makeProxyHandler(client, config, activator, {
              service: "edge-runtime",
              backendPort: config.edgeRuntimePort,
              stripPrefix: "/functions/v1",
              transformAuth: true,
              transformAuthCustomHeader: true,
              retryColdStart: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/realtime/v1/api/*",
            makeProxyHandler(client, config, activator, {
              service: "realtime",
              backendPort: config.realtimePort,
              stripPrefix: "/realtime/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/realtime/v1/*",
            makeProxyHandler(client, config, activator, {
              service: "realtime",
              backendPort: config.realtimePort,
              stripPrefix: "/realtime/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/storage/v1/s3/*",
            makeProxyHandler(client, config, activator, {
              service: "storage",
              backendPort: config.storagePort,
              stripPrefix: "/storage/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/storage/v1/*",
            makeProxyHandler(client, config, activator, {
              service: "storage",
              backendPort: config.storagePort,
              stripPrefix: "/storage/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/pg/*",
            makeProxyHandler(client, config, activator, {
              service: "pgmeta",
              backendPort: config.pgmetaPort,
              stripPrefix: "/pg",
            }),
          ),
          HttpRouter.route(
            "*",
            "/analytics/v1/*",
            makeProxyHandler(client, config, activator, {
              service: "analytics",
              backendPort: config.analyticsPort,
              stripPrefix: "/analytics/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/pooler/v2/*",
            makeProxyHandler(client, config, activator, {
              service: "pooler",
              backendPort: config.poolerPort,
              stripPrefix: "/pooler",
            }),
          ),
          HttpRouter.route(
            "*",
            "/mcp",
            makeProxyHandler(client, config, activator, {
              service: "studio",
              backendPort: config.studioPort,
              backendPath: "/api/mcp",
            }),
          ),
        ];

        const httpEffect = yield* HttpRouter.toHttpEffect(HttpRouter.addAll(routes));

        const appEffect = Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;

          if (req.method === "OPTIONS") {
            return addCorsHeaders(HttpServerResponse.empty({ status: 204 }));
          }

          const response = yield* httpEffect;
          return addCorsHeaders(response);
        });

        yield* Effect.forkScoped(server.serve(appEffect));

        return {
          address: server.address,
        };
      }),
    );
}
