import {
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Latch,
  Option,
  Predicate,
  Queue,
  Result,
  Schedule,
  Scope,
} from "effect";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
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
import { StackServiceActivator } from "./ServiceActivation.ts";
import type { ServiceName } from "./ServiceName.ts";

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

class RealtimeWebSocketProxyError extends Data.TaggedError("RealtimeWebSocketProxyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class RealtimeBackendSocketClosed extends Data.TaggedError("RealtimeBackendSocketClosed")<{
  readonly closeEvent: Socket.CloseEvent;
}> {}

class RealtimeClientFrameBufferOverflow extends Data.TaggedError(
  "RealtimeClientFrameBufferOverflow",
)<{
  readonly message: string;
}> {}

const REALTIME_CLIENT_FRAME_BUFFER_CAPACITY = 256;

type RealtimeWebSocketFactory = (
  requestUrl: string,
  config: ProxyConfig,
  protocols: Array<string>,
) => Effect.Effect<Socket.Socket, Socket.SocketError, Scope.Scope>;

export interface ApiProxyOptions {
  readonly realtimeWebSocketFactory?: RealtimeWebSocketFactory;
}

function transformRealtimeWebSocketUrl(requestUrl: string, config: ProxyConfig): string {
  const stripped = requestUrl.startsWith("/realtime/v1")
    ? requestUrl.slice("/realtime/v1".length)
    : requestUrl;
  const relative = stripped === "" ? "/" : stripped;
  const url = new URL(relative, `ws://127.0.0.1:${config.realtimePort}`);
  url.pathname = `/socket${url.pathname}`;

  const apikey = url.searchParams.get("apikey");
  if (apikey === config.publishableKey) {
    url.searchParams.set("apikey", config.anonJwt);
  } else if (apikey === config.secretKey) {
    url.searchParams.set("apikey", config.serviceRoleJwt);
  }

  return url.toString();
}

const isSendableWebSocketCloseCode = (code: number): boolean =>
  Number.isInteger(code) &&
  ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999));

const backendCloseEvent = (error: Socket.SocketError): Socket.CloseEvent | undefined => {
  if (!Predicate.isTagged(error.reason, "SocketCloseError")) return undefined;

  const { code, closeReason } = error.reason;
  if (code === 1005) return new Socket.CloseEvent(1000, closeReason ?? "");
  if (code === 1006) return new Socket.CloseEvent(1011, "realtime backend connection lost");
  if (
    !isSendableWebSocketCloseCode(code) ||
    (closeReason !== undefined && Buffer.byteLength(closeReason, "utf8") > 123)
  ) {
    return new Socket.CloseEvent(1011, "realtime backend sent an invalid close frame");
  }

  return new Socket.CloseEvent(code, closeReason);
};

const backendWriterCloseEvent = (error: Socket.SocketError): Socket.CloseEvent =>
  backendCloseEvent(error) ?? new Socket.CloseEvent(1011, "realtime backend connection lost");

function websocketMessageChunk(
  data: NodeSocket.NodeWS.RawData,
  isBinary: boolean,
): string | Uint8Array {
  if (!isBinary) {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return data;
}

function realtimeClientFrame(chunk: string | Uint8Array): string | Uint8Array {
  // The upgraded server socket boundary loses text/binary metadata. Realtime
  // frames are JSON text, so sniffing arrays and objects restores JSON chunks as text.
  if (typeof chunk === "string") return chunk;

  let offset = 0;
  while (
    offset < chunk.length &&
    (chunk[offset] === 0x09 ||
      chunk[offset] === 0x0a ||
      chunk[offset] === 0x0d ||
      chunk[offset] === 0x20)
  ) {
    offset += 1;
  }

  return chunk[offset] === 0x5b || chunk[offset] === 0x7b ? new TextDecoder().decode(chunk) : chunk;
}

function makeNodeWebSocketSocket(
  websocket: NodeSocket.NodeWS.WebSocket,
): Effect.Effect<Socket.Socket> {
  return Effect.withFiber(() => {
    const latch = Latch.makeUnsafe(false);
    let currentWebSocket: NodeSocket.NodeWS.WebSocket | undefined;

    const runRaw = <_, E, R>(
      handler: (_: string | Uint8Array) => Effect.Effect<_, E, R> | void,
      options?: { readonly onOpen?: Effect.Effect<void> | undefined },
    ) =>
      Effect.scopedWith(
        Effect.fnUntraced(function* (scope) {
          const fiberSet = yield* FiberSet.make<any, E | Socket.SocketError>().pipe(
            Scope.provide(scope),
          );
          const run = yield* FiberSet.runtime(fiberSet)<R>();
          let open = websocket.readyState === NodeSocket.NodeWS.WebSocket.OPEN;

          const onMessage = (data: NodeSocket.NodeWS.RawData, isBinary: boolean) => {
            const chunk = websocketMessageChunk(data, isBinary);
            const result = handler(chunk);
            if (Effect.isEffect(result)) {
              run(result);
            }
          };
          const onError = (cause: Error) => {
            websocket.off("message", onMessage);
            websocket.off("close", onClose);
            Deferred.doneUnsafe(
              fiberSet.deferred,
              Effect.fail(
                new Socket.SocketError({
                  reason: open
                    ? new Socket.SocketReadError({ cause })
                    : new Socket.SocketOpenError({ kind: "Unknown", cause }),
                }),
              ),
            );
          };
          const onClose = (code: number, reason: Buffer) => {
            websocket.off("message", onMessage);
            websocket.off("error", onError);
            Deferred.doneUnsafe(
              fiberSet.deferred,
              Effect.fail(
                new Socket.SocketError({
                  reason: new Socket.SocketCloseError({
                    code,
                    closeReason: reason.toString(),
                  }),
                }),
              ),
            );
          };

          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              websocket.off("message", onMessage);
              websocket.off("error", onError);
              websocket.off("close", onClose);
              if (currentWebSocket === websocket) {
                currentWebSocket = undefined;
                latch.closeUnsafe();
              }
            }),
          );

          websocket.on("message", onMessage);
          websocket.once("error", onError);
          websocket.once("close", onClose);

          if (!open) {
            const opened = Deferred.makeUnsafe<void>();
            const onSocketOpen = () => {
              open = true;
              Deferred.doneUnsafe(opened, Effect.void);
            };
            websocket.once("open", onSocketOpen);
            yield* Deferred.await(opened).pipe(
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () =>
                  Effect.fail(
                    new Socket.SocketError({
                      reason: new Socket.SocketOpenError({
                        kind: "Timeout",
                        cause: new Error("timeout waiting for realtime websocket"),
                      }),
                    }),
                  ),
              }),
              Effect.raceFirst(FiberSet.join(fiberSet)),
            );
          }

          currentWebSocket = websocket;
          latch.openUnsafe();
          if (options?.onOpen) {
            yield* options.onOpen;
          }
          return yield* FiberSet.join(fiberSet);
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            latch.closeUnsafe();
            currentWebSocket = undefined;
          }),
        ),
      );

    const writer = Effect.acquireRelease(
      Effect.succeed((chunk: Uint8Array | string | Socket.CloseEvent) =>
        latch.whenOpen(
          Effect.suspend(() => {
            try {
              const active = currentWebSocket;
              if (active === undefined) {
                return Effect.fail(
                  new Socket.SocketError({
                    reason: new Socket.SocketWriteError({
                      cause: new Error("realtime websocket is not open"),
                    }),
                  }),
                );
              }
              if (Socket.isCloseEvent(chunk)) {
                active.close(chunk.code, chunk.reason);
              } else {
                active.send(chunk);
              }
              return Effect.void;
            } catch (cause) {
              return Effect.fail(
                new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause }) }),
              );
            }
          }),
        ),
      ),
      () => Effect.sync(() => currentWebSocket?.close(1000)),
    );

    return Effect.succeed(Socket.make({ runRaw, writer }));
  });
}

function openRealtimeWebSocket(
  requestUrl: string,
  config: ProxyConfig,
  protocols: Array<string>,
): Effect.Effect<NodeSocket.NodeWS.WebSocket, Socket.SocketError> {
  return Effect.callback((resume, signal) => {
    const backendUrl = transformRealtimeWebSocketUrl(requestUrl, config);
    const websocket = new NodeSocket.NodeWS.WebSocket(backendUrl, protocols, {
      headers: { host: config.realtimeTenantId },
    });
    const onOpen = () => {
      websocket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resume(Effect.succeed(websocket));
    };
    const onError = (cause: Error) => {
      resume(
        Effect.fail(
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
          }),
        ),
      );
    };
    const onAbort = () => websocket.terminate();

    websocket.once("open", onOpen);
    websocket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });

    return Effect.sync(() => {
      signal.removeEventListener("abort", onAbort);
      websocket.off("open", onOpen);
      websocket.off("error", onError);
      if (
        websocket.readyState === NodeSocket.NodeWS.WebSocket.OPEN ||
        websocket.readyState === NodeSocket.NodeWS.WebSocket.CONNECTING
      ) {
        websocket.terminate();
      }
    });
  });
}

function makeRealtimeWebSocket(
  requestUrl: string,
  config: ProxyConfig,
  protocols: Array<string>,
): Effect.Effect<Socket.Socket, Socket.SocketError, Scope.Scope> {
  return Effect.acquireRelease(openRealtimeWebSocket(requestUrl, config, protocols), (websocket) =>
    Effect.sync(() => {
      if (
        websocket.readyState === NodeSocket.NodeWS.WebSocket.OPEN ||
        websocket.readyState === NodeSocket.NodeWS.WebSocket.CONNECTING
      ) {
        websocket.terminate();
      }
    }),
  ).pipe(Effect.flatMap(makeNodeWebSocketSocket));
}

function makeRealtimeWebSocketHandler(
  config: ProxyConfig,
  activator: StackServiceActivator["Service"],
  signalTerminalFailure: Effect.Effect<void>,
  runBridge: (effect: Effect.Effect<void, never, never>) => Fiber.Fiber<void, never>,
  realtimeWebSocketFactory: RealtimeWebSocketFactory = makeRealtimeWebSocket,
) {
  return (req: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const protocolHeader = req.headers["sec-websocket-protocol"];
      const protocols =
        protocolHeader === undefined
          ? []
          : protocolHeader
              .split(",")
              .map((protocol) => protocol.trim())
              .filter((protocol) => protocol !== "");
      const clientSocket = yield* req.upgrade.pipe(
        Effect.mapError(
          (error) =>
            new RealtimeWebSocketProxyError({
              message: error.message,
              cause: error,
            }),
        ),
      );
      // Return as soon as the upgrade is accepted. The bridge is kept in the
      // layer-owned FiberSet so it outlives request completion and can cleanly
      // close both sockets when the stack shuts down.
      const bridge = Effect.scoped(
        Effect.gen(function* () {
          const clientWriter =
            yield* Deferred.make<
              (
                chunk: Uint8Array | string | Socket.CloseEvent,
              ) => Effect.Effect<void, Socket.SocketError>
            >();
          const backendWriter =
            yield* Deferred.make<
              (
                chunk: Uint8Array | string | Socket.CloseEvent,
              ) => Effect.Effect<void, Socket.SocketError>
            >();
          const clientFrames = yield* Queue.bounded<string | Uint8Array>(
            REALTIME_CLIENT_FRAME_BUFFER_CAPACITY,
          );
          const clientFrameBufferOverflow = yield* Deferred.make<
            void,
            RealtimeClientFrameBufferOverflow
          >();

          const clientReader = clientSocket
            .runRaw((chunk) => {
              if (!Queue.offerUnsafe(clientFrames, realtimeClientFrame(chunk))) {
                Deferred.doneUnsafe(
                  clientFrameBufferOverflow,
                  Effect.fail(
                    new RealtimeClientFrameBufferOverflow({
                      message: "realtime client frame buffer exhausted",
                    }),
                  ),
                );
              }
            })
            .pipe(
              Effect.catchTags({
                SocketError: (error) =>
                  Predicate.isTagged(error.reason, "SocketCloseError")
                    ? Effect.void
                    : Effect.fail(error),
              }),
            );
          const clientFrameWriter = Effect.forever(
            Effect.gen(function* () {
              const chunk = yield* Queue.take(clientFrames);
              const write = yield* Deferred.await(backendWriter);
              yield* write(chunk);
            }),
          );
          const clientToBackend = Effect.raceFirst(
            clientReader,
            Effect.raceFirst(clientFrameWriter, Deferred.await(clientFrameBufferOverflow)),
          ).pipe(
            Effect.catchTag("SocketError", (error) =>
              Effect.fail(
                new RealtimeBackendSocketClosed({
                  closeEvent: backendWriterCloseEvent(error),
                }),
              ),
            ),
            Effect.catchTag("RealtimeBackendSocketClosed", ({ closeEvent }) =>
              Effect.succeed(closeEvent),
            ),
          );
          const clientFiber = yield* clientToBackend.pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.succeed(clientWriter, yield* clientSocket.writer);

          const closeClient = (event: Socket.CloseEvent) =>
            Deferred.await(clientWriter).pipe(
              Effect.flatMap((write) => write(event)),
              Effect.catchTag("SocketError", () => Effect.void),
            );
          const activation = yield* activator.activate("realtime").pipe(
            Effect.tapErrorTag("StackReadinessError", () => signalTerminalFailure),
            Effect.result,
          );
          if (Result.isFailure(activation)) {
            yield* closeClient(new Socket.CloseEvent(1013, "realtime unavailable"));
            return;
          }

          const backendResult = yield* realtimeWebSocketFactory(req.url, config, protocols).pipe(
            Effect.mapError(
              (error) =>
                new RealtimeWebSocketProxyError({
                  message: error.message,
                  cause: error,
                }),
            ),
            Effect.result,
          );
          if (Result.isFailure(backendResult)) {
            yield* closeClient(new Socket.CloseEvent(1011, "realtime proxy error"));
            return;
          }
          const backendSocket = backendResult.success;
          const backendToClient = backendSocket
            .runRaw((chunk) =>
              Effect.flatMap(Deferred.await(clientWriter), (write) => write(chunk)),
            )
            .pipe(
              Effect.catchTag("SocketError", (error) => {
                const closeEvent = backendCloseEvent(error);
                return closeEvent === undefined ? Effect.fail(error) : Effect.succeed(closeEvent);
              }),
            );
          const bridge = Effect.raceFirst(Fiber.join(clientFiber), backendToClient).pipe(
            Effect.mapError((error) =>
              error instanceof RealtimeWebSocketProxyError
                ? error
                : new RealtimeWebSocketProxyError({
                    message: error.message,
                    cause: error,
                  }),
            ),
          );
          yield* Deferred.succeed(backendWriter, yield* backendSocket.writer);
          const bridgeResult = yield* bridge.pipe(Effect.result);
          if (Result.isSuccess(bridgeResult) && Socket.isCloseEvent(bridgeResult.success)) {
            yield* closeClient(bridgeResult.success);
          } else if (Result.isFailure(bridgeResult)) {
            yield* closeClient(new Socket.CloseEvent(1011, "realtime proxy error"));
          }
        }),
      );
      runBridge(bridge);
      return HttpServerResponse.empty();
    }).pipe(
      Effect.catchTag("RealtimeWebSocketProxyError", (error) =>
        Effect.succeed(HttpServerResponse.text(`Bad gateway: ${error.message}`, { status: 502 })),
      ),
    );
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
  signalTerminalFailure: Effect.Effect<void>,
  opts: ProxyHandlerOptions,
) {
  return (req: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const activation = yield* activator.activate(opts.service).pipe(
        Effect.tapErrorTag("StackReadinessError", () => signalTerminalFailure),
        Effect.result,
      );
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
            while: (error) => Predicate.isTagged(error.reason, "TransportError"),
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

export class ApiProxy extends Context.Service<
  ApiProxy,
  {
    readonly address: HttpServer.Address;
    /** Completes when terminal lazy-activation failure requires daemon teardown. */
    readonly awaitTerminalFailure: Effect.Effect<void>;
  }
>()("local/ApiProxy") {
  static layer = (
    config: ProxyConfig,
    options: ApiProxyOptions = {},
  ): Layer.Layer<
    ApiProxy,
    never,
    HttpServer.HttpServer | HttpClient.HttpClient | StackServiceActivator
  > =>
    Layer.effect(ApiProxy)(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const client = yield* HttpClient.HttpClient;
        const activator = yield* StackServiceActivator;
        const terminalFailure = yield* Deferred.make<void>();
        const signalTerminalFailure = Deferred.succeed(terminalFailure, void 0).pipe(Effect.asVoid);
        const realtimeBridges = yield* FiberSet.makeRuntime<never, void, never>();
        const realtimeHttpHandler = makeProxyHandler(
          client,
          config,
          activator,
          signalTerminalFailure,
          {
            service: "realtime",
            backendPort: config.realtimePort,
            stripPrefix: "/realtime/v1",
          },
        );
        const realtimeWebSocketHandler = makeRealtimeWebSocketHandler(
          config,
          activator,
          signalTerminalFailure,
          realtimeBridges,
          options.realtimeWebSocketFactory,
        );

        const routes = [
          HttpRouter.route("*", "/health", HttpServerResponse.text("OK", { status: 200 })),
          HttpRouter.route(
            "*",
            "/.well-known/oauth-authorization-server",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "auth",
              backendPort: config.gotruePort,
              backendPath: "/.well-known/oauth-authorization-server",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/verify",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/callback",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/authorize",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/auth/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "auth",
              backendPort: config.gotruePort,
              stripPrefix: "/auth/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/rest/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "postgrest",
              backendPort: config.postgrestPort,
              stripPrefix: "/rest/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/rest-admin/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "postgrest",
              backendPort: config.postgrestAdminPort,
              stripPrefix: "/rest-admin/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/graphql/v1",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
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
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
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
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "realtime",
              backendPort: config.realtimePort,
              stripPrefix: "/realtime/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route("GET", "/realtime/v1/websocket", (req) =>
            req.headers.upgrade?.toLowerCase() === "websocket"
              ? realtimeWebSocketHandler(req)
              : realtimeHttpHandler(req),
          ),
          HttpRouter.route("*", "/realtime/v1/*", realtimeHttpHandler),
          HttpRouter.route(
            "*",
            "/storage/v1/s3/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "storage",
              backendPort: config.storagePort,
              stripPrefix: "/storage/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/storage/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "storage",
              backendPort: config.storagePort,
              stripPrefix: "/storage/v1",
              transformAuth: true,
            }),
          ),
          HttpRouter.route(
            "*",
            "/pg/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "pgmeta",
              backendPort: config.pgmetaPort,
              stripPrefix: "/pg",
            }),
          ),
          HttpRouter.route(
            "*",
            "/analytics/v1/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "analytics",
              backendPort: config.analyticsPort,
              stripPrefix: "/analytics/v1",
            }),
          ),
          HttpRouter.route(
            "*",
            "/pooler/v2/*",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
              service: "pooler",
              backendPort: config.poolerPort,
              stripPrefix: "/pooler",
            }),
          ),
          HttpRouter.route(
            "*",
            "/mcp",
            makeProxyHandler(client, config, activator, signalTerminalFailure, {
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
          awaitTerminalFailure: Deferred.await(terminalFailure),
        };
      }),
    );
}
