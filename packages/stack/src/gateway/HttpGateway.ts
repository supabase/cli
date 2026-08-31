import { Cause, Data, Effect, Exit, FiberSet, Option, Scope } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {
  createServer,
  request as proxyRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  // oxlint-disable-next-line effecttsgo/node-builtin-import
} from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Fiber } from "effect/Fiber";
import {
  GatewayActivationError,
  GatewayAuthenticationError,
  GatewayStaleGenerationError,
} from "../public/Errors.ts";
import type {
  ActivationResult,
  BackendEndpoint,
  GatewayLocalResponse,
  GatewayProxyRoute,
  GatewayRoute,
  GatewayRouteRequest,
  GatewayHeaders,
  LazyActivator,
  PreparedGatewayRoute,
} from "./Gateway.ts";
import { GatewayRouteNotFoundError, isGatewayProxyRoute } from "./Gateway.ts";
import type { HostListener } from "../state/PortCoordinator.ts";

class GatewayBackendError extends Data.TaggedError("GatewayBackendError")<{
  readonly cause?: unknown;
}> {}

export interface HttpGatewayOptions {
  readonly address?: string;
  readonly port?: number;
  readonly listener?: HostListener;
  readonly routes: ReadonlyArray<GatewayRoute>;
  readonly activate: LazyActivator["activate"];
  readonly resolveBackend?: (
    route: GatewayProxyRoute,
    request: GatewayRouteRequest,
    activation: ActivationResult,
  ) => Effect.Effect<BackendEndpoint, GatewayActivationError>;
  readonly cors?: Readonly<Record<string, string>>;
  readonly healthPaths?: ReadonlyArray<string>;
}

export interface HttpGateway {
  readonly address: string;
  readonly port: number;
  readonly close: Effect.Effect<void>;
  readonly server: Server;
}

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const requestView = (request: IncomingMessage): GatewayRouteRequest => ({
  path: request.url ?? "/",
  method: request.method,
  headers: request.headers,
});

const setCors = (response: ServerResponse, options: HttpGatewayOptions) => {
  response.setHeader(
    "access-control-allow-origin",
    options.cors?.["access-control-allow-origin"] ?? "*",
  );
  response.setHeader(
    "access-control-allow-methods",
    options.cors?.["access-control-allow-methods"] ?? "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  response.setHeader(
    "access-control-allow-headers",
    options.cors?.["access-control-allow-headers"] ?? "authorization,content-type",
  );
  for (const [name, value] of Object.entries(options.cors ?? {})) response.setHeader(name, value);
};

const respond = (
  response: ServerResponse,
  status: number,
  body: string,
  options: HttpGatewayOptions,
) => {
  setCors(response, options);
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(body);
};

const respondLocal = (
  response: ServerResponse,
  local: GatewayLocalResponse,
  options: HttpGatewayOptions,
): void => {
  setCors(response, options);
  response.statusCode = local.status ?? 200;
  response.setHeader("content-type", local.contentType ?? "application/octet-stream");
  response.end(local.body);
};

const routeFor = (
  request: GatewayRouteRequest,
  routes: ReadonlyArray<GatewayRoute>,
): GatewayRoute | undefined => routes.find((route) => route.match(request));

const preparedPath = (
  route: GatewayRoute,
  prepared: PreparedGatewayRoute | undefined,
  request: GatewayRouteRequest,
): string => prepared?.upstreamPath?.(request) ?? route.upstreamPath?.(request) ?? request.path;

const filteredRequestHeaders = (request: IncomingMessage): Record<string, string | string[]> => {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !hopByHop.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
};

const withForwardedHeaders = (
  request: IncomingMessage,
  headers: GatewayHeaders,
): Record<string, string | string[]> => {
  const forwarded = new Map<string, string | string[]>();
  for (const [name, value] of Object.entries(headers)) {
    if (!name.toLowerCase().startsWith("x-forwarded-")) forwarded.set(name, value);
  }
  forwarded.set("x-forwarded-host", request.headers.host ?? "");
  forwarded.set("x-forwarded-proto", "http");
  forwarded.set("x-forwarded-for", request.socket.remoteAddress ?? "");
  return Object.fromEntries(forwarded);
};

const preparedHeaders = (
  route: GatewayRoute,
  prepared: PreparedGatewayRoute | undefined,
  view: GatewayRouteRequest,
  request: IncomingMessage,
): Record<string, string | string[]> =>
  withForwardedHeaders(
    request,
    prepared?.upstreamHeaders?.(view, filteredRequestHeaders(request)) ??
      route.upstreamHeaders?.(view, filteredRequestHeaders(request)) ??
      filteredRequestHeaders(request),
  );

const proxy = (
  request: IncomingMessage,
  response: ServerResponse,
  backend: BackendEndpoint,
  options: HttpGatewayOptions,
  upstreamPath: string,
  headers: Record<string, string | string[]>,
): Effect.Effect<void, GatewayBackendError> =>
  Effect.callback<void, GatewayBackendError>((resume) => {
    let settled = false;
    let outgoing: ReturnType<typeof proxyRequest> | undefined;
    let incoming: IncomingMessage | undefined;
    const onIncomingError = (cause: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      outgoing?.destroy();
      incoming?.destroy();
      resume(Effect.fail(new GatewayBackendError({ cause })));
    };
    const onIncomingAborted = () => onIncomingError(new Error("backend response aborted"));
    const onIncomingEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(Effect.void);
    };
    const onOutgoingError = (cause: Error) => onIncomingError(cause);
    const onRequestAborted = () => onIncomingError(new Error("request aborted"));
    const onResponseClose = () => {
      if (settled || response.writableEnded) return;
      onIncomingError(new Error("response closed"));
    };
    const cleanup = () => {
      if (outgoing !== undefined) outgoing.off("error", onOutgoingError);
      request.off("aborted", onRequestAborted);
      response.off("close", onResponseClose);
      if (incoming !== undefined) {
        incoming.off("error", onIncomingError);
        incoming.off("aborted", onIncomingAborted);
        incoming.off("end", onIncomingEnd);
      }
    };
    const onIncoming = (value: IncomingMessage) => {
      incoming = value;
      value.once("error", onIncomingError);
      value.once("aborted", onIncomingAborted);
      value.once("end", onIncomingEnd);
      setCors(response, options);
      response.statusCode = value.statusCode ?? 502;
      for (const [name, headerValue] of Object.entries(value.headers)) {
        if (
          headerValue !== undefined &&
          !hopByHop.has(name.toLowerCase()) &&
          !name.toLowerCase().startsWith("access-control-")
        )
          response.setHeader(name, headerValue);
      }
      value.pipe(response);
    };

    outgoing = proxyRequest(
      {
        host: backend.host,
        port: backend.port,
        method: request.method,
        path: upstreamPath,
        headers,
      },
      onIncoming,
    );
    outgoing.once("error", onOutgoingError);
    request.once("aborted", onRequestAborted);
    response.once("close", onResponseClose);
    request.pipe(outgoing);
    return Effect.sync(() => {
      cleanup();
      outgoing.destroy();
      incoming?.destroy();
    });
  });

const mapFailure = (cause: Cause.Cause<unknown>): number => {
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error) && error.value instanceof GatewayRouteNotFoundError) return 404;
  if (Option.isSome(error) && error.value instanceof GatewayBackendError) return 502;
  if (
    Option.isSome(error) &&
    (error.value instanceof GatewayAuthenticationError ||
      error.value instanceof GatewayStaleGenerationError)
  )
    return 503;
  return 503;
};

const handleRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpGatewayOptions,
  runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber<A, E>,
): void => {
  const view = requestView(request);
  setCors(response, options);
  const earlyRoute = routeFor(view, options.routes);
  if (request.method === "OPTIONS") {
    if (earlyRoute?.localResponse !== undefined) {
      respond(response, 404, JSON.stringify({ error: "Not found" }), options);
      return;
    }
    response.statusCode = 204;
    response.end();
    return;
  }
  const health = options.healthPaths ?? ["/health", "/healthz", "/status"];
  const pathname = view.path.split("?", 1)[0] ?? view.path;
  if (health.some((path) => pathname === path)) {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  const route = routeFor(view, options.routes);
  if (route === undefined) {
    respond(response, 404, JSON.stringify({ error: "Not found" }), options);
    return;
  }
  if (route.localResponse !== undefined) {
    const local = route.localResponse(view);
    const fiber = runFork(local);
    fiber.addObserver((exit) => {
      if (Exit.isSuccess(exit)) respondLocal(response, exit.value, options);
      else if (!response.writableEnded && !response.destroyed)
        respond(response, 404, JSON.stringify({ error: "Not found" }), options);
    });
    return;
  }
  if (!isGatewayProxyRoute(route)) {
    respond(response, 404, JSON.stringify({ error: "Not found" }), options);
    return;
  }
  const preparation: Effect.Effect<
    PreparedGatewayRoute | undefined,
    GatewayRouteNotFoundError | GatewayActivationError
  > = route.prepare === undefined ? Effect.as(Effect.void, undefined) : route.prepare(view);
  const activation = preparation.pipe(
    Effect.flatMap((prepared) =>
      Effect.suspend(() => options.activate(route.capability)).pipe(
        Effect.flatMap((result) => {
          const resolved =
            prepared === undefined
              ? options.resolveBackend === undefined
                ? Effect.succeed(result.endpoint)
                : options.resolveBackend(route, view, result)
              : prepared.resolveBackend(result);
          return resolved.pipe(
            Effect.map((backend) => ({
              backend,
              path: preparedPath(route, prepared, view),
              headers: preparedHeaders(route, prepared, view, request),
            })),
            Effect.mapError((cause) => new GatewayBackendError({ cause })),
          );
        }),
      ),
    ),
    Effect.flatMap(({ backend, path, headers }) =>
      proxy(request, response, backend, options, path, headers),
    ),
  );
  // Node invokes this handler outside Effect; use the owner-scoped FiberSet
  // runtime so cancellation of the gateway interrupts in-flight activation.
  const fiber = runFork(activation);
  fiber.addObserver((exit) => {
    if (!Exit.isFailure(exit) || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = mapFailure(exit.cause);
    respond(
      response,
      status,
      JSON.stringify({
        error:
          status === 404 ? "Not found" : status === 503 ? "Service unavailable" : "Bad gateway",
      }),
      options,
    );
  });
};

const writeUpgrade = (
  request: IncomingMessage,
  path: string,
  forwardedHeaders: Readonly<Record<string, string | string[]>>,
): string => {
  const lines = [`${request.method ?? "GET"} ${path} HTTP/${request.httpVersion}`];
  for (const [name, value] of Object.entries(forwardedHeaders)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) lines.push(`${name}: ${item}`);
  }
  lines.push("Connection: Upgrade", "Upgrade: websocket");
  return `${lines.join("\r\n")}\r\n\r\n`;
};

const handleUpgrade = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: HttpGatewayOptions,
  runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber<A, E>,
  active: Set<Duplex>,
): void => {
  active.add(socket);
  socket.once("close", () => active.delete(socket));
  const view = requestView(request);
  const route = routeFor(view, options.routes);
  if (route === undefined) {
    socket.destroy();
    return;
  }
  // Local routes are HTTP-only and must never invoke their handler for upgrades.
  if (route.localResponse !== undefined) {
    socket.destroy();
    return;
  }
  if (!isGatewayProxyRoute(route)) {
    socket.destroy();
    return;
  }
  const preparation: Effect.Effect<
    PreparedGatewayRoute | undefined,
    GatewayRouteNotFoundError | GatewayActivationError
  > = route.prepare === undefined ? Effect.as(Effect.void, undefined) : route.prepare(view);
  const activation = preparation.pipe(
    Effect.flatMap((prepared) =>
      Effect.suspend(() => options.activate(route.capability)).pipe(
        Effect.flatMap((result) => {
          const resolved =
            prepared === undefined
              ? options.resolveBackend === undefined
                ? Effect.succeed(result.endpoint)
                : options.resolveBackend(route, view, result)
              : prepared.resolveBackend(result);
          return resolved.pipe(
            Effect.map((backend) => ({
              backend,
              path: preparedPath(route, prepared, view),
              headers: preparedHeaders(route, prepared, view, request),
            })),
            Effect.mapError((cause) => new GatewayBackendError({ cause })),
          );
        }),
      ),
    ),
    Effect.flatMap(({ backend, path, headers }) =>
      Effect.callback<void, GatewayBackendError>((resume) => {
        const target = new Socket();
        let settled = false;
        const fail = (cause: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          target.destroy();
          socket.destroy();
          resume(Effect.fail(new GatewayBackendError({ cause })));
        };
        const onTargetError = (cause: Error) => fail(cause);
        const onSocketClose = () => {
          target.destroy();
          if (!settled) {
            settled = true;
            cleanup();
            resume(Effect.void);
          }
        };
        const onTargetClose = () => {
          socket.destroy();
          if (!settled) {
            settled = true;
            cleanup();
            resume(Effect.void);
          }
        };
        const onSocketEnd = () => target.end();
        const onTargetEnd = () => socket.end();
        const onConnect = () => {
          target.write(writeUpgrade(request, path, headers));
          if (head.byteLength > 0) target.write(head);
          socket.pipe(target, { end: false });
          target.pipe(socket, { end: false });
          socket.once("end", onSocketEnd);
          target.once("end", onTargetEnd);
        };
        const cleanup = () => {
          target.off("error", onTargetError);
          target.off("connect", onConnect);
          target.off("close", onTargetClose);
          socket.off("close", onSocketClose);
          socket.off("end", onSocketEnd);
          target.off("end", onTargetEnd);
        };
        target.once("error", onTargetError);
        target.once("connect", onConnect);
        target.once("close", onTargetClose);
        socket.once("close", onSocketClose);
        target.connect(backend.port, backend.host);
        return Effect.sync(() => {
          settled = true;
          cleanup();
          target.destroy();
          socket.destroy();
        });
      }),
    ),
  );
  const fiber = runFork(activation);
  fiber.addObserver((exit) => {
    if (Exit.isFailure(exit)) socket.destroy();
  });
};

/** Start an HTTP gateway, optionally adopting an already-bound native server. */
export const makeHttpGateway = (
  options: HttpGatewayOptions,
): Effect.Effect<HttpGateway, GatewayActivationError, Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make<unknown, unknown>();
    const runFork = yield* FiberSet.runtime(fibers)<never>();
    if (options.listener?.binding?.kind === "tcp")
      return yield* new GatewayActivationError({ message: "Gateway listener protocol mismatch" });
    const server =
      options.listener?.binding?.kind === "http" ? options.listener.binding.server : createServer();
    if (options.listener !== undefined && !server.listening)
      return yield* new GatewayActivationError({ message: "Gateway listener is not bound" });
    const active = new Set<Duplex>();
    const connectionHandler = (socket: Duplex) => {
      active.add(socket);
      socket.once("close", () => active.delete(socket));
    };
    const requestHandler = (request: IncomingMessage, response: ServerResponse) =>
      handleRequest(request, response, options, runFork);
    const upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) =>
      handleUpgrade(request, socket, head, options, runFork, active);
    server.on("connection", connectionHandler);
    server.on("request", requestHandler);
    server.on("upgrade", upgradeHandler);
    if (!server.listening) {
      yield* Effect.callback<void, GatewayActivationError>((resume) => {
        let settled = false;
        const cleanup = () => {
          server.off("error", onError);
          server.close(() => undefined);
        };
        const onError = (cause: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          resume(
            Effect.fail(
              new GatewayActivationError({ message: "Gateway listener unavailable", cause }),
            ),
          );
        };
        server.once("error", onError);
        server.listen({ host: options.address ?? "127.0.0.1", port: options.port ?? 0 }, () => {
          if (settled) return;
          settled = true;
          server.off("error", onError);
          resume(Effect.void);
        });
        return Effect.sync(() => {
          if (settled) return;
          settled = true;
          cleanup();
        });
      });
    }
    const address = server.address();
    if (typeof address !== "object" || address === null)
      return yield* new GatewayActivationError({
        message: "Gateway listener did not expose an endpoint",
      });
    const closeOperation = Effect.gen(function* () {
      server.off("request", requestHandler);
      server.off("upgrade", upgradeHandler);
      server.off("connection", connectionHandler);
      yield* FiberSet.clear(fibers);
      for (const socket of active) socket.destroy();
      if (options.listener !== undefined) yield* options.listener.close;
      yield* Effect.callback<void>((resume) => {
        if (!server.listening) return resume(Effect.void);
        server.close(() => resume(Effect.void));
      });
    });
    const close = yield* Effect.cached(closeOperation);
    yield* Effect.addFinalizer(() => close);
    return { address: address.address, port: address.port, close, server } satisfies HttpGateway;
  });
