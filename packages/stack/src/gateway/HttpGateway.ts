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
  GatewayRoute,
  GatewayRouteRequest,
  LazyActivator,
} from "./Gateway.ts";
import type { NativeListener } from "../state/PortCoordinator.ts";

class GatewayBackendError extends Data.TaggedError("GatewayBackendError")<{
  readonly cause?: unknown;
}> {}

export interface HttpGatewayOptions {
  readonly address?: string;
  readonly port?: number;
  readonly listener?: NativeListener;
  readonly routes: ReadonlyArray<GatewayRoute>;
  readonly activate: LazyActivator["activate"];
  readonly resolveBackend?: (
    route: GatewayRoute,
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

const routeFor = (
  request: GatewayRouteRequest,
  routes: ReadonlyArray<GatewayRoute>,
): GatewayRoute | undefined => routes.find((route) => route.match(request));

const proxy = (
  request: IncomingMessage,
  response: ServerResponse,
  backend: BackendEndpoint,
  options: HttpGatewayOptions,
): Effect.Effect<void, GatewayBackendError> =>
  Effect.callback<void, GatewayBackendError>((resume) => {
    let settled = false;
    let outgoing: ReturnType<typeof proxyRequest> | undefined;
    let incoming: IncomingMessage | undefined;
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && !hopByHop.has(name.toLowerCase())) headers[name] = value;
    }
    headers["x-forwarded-host"] = request.headers.host ?? "";
    headers["x-forwarded-proto"] = "http";
    headers["x-forwarded-for"] = request.socket.remoteAddress ?? "";

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
        path: request.url ?? "/",
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
  if (request.method === "OPTIONS") {
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
  const activation = options.activate(route.capability).pipe(
    Effect.flatMap((result) =>
      options.resolveBackend === undefined
        ? Effect.succeed(result.endpoint)
        : options
            .resolveBackend(route, view, result)
            .pipe(Effect.mapError((cause) => new GatewayBackendError({ cause }))),
    ),
    Effect.flatMap((backend) => proxy(request, response, backend, options)),
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
      JSON.stringify({ error: status === 503 ? "Service unavailable" : "Bad gateway" }),
      options,
    );
  });
};

const writeUpgrade = (request: IncomingMessage): string => {
  const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) lines.push(`${name}: ${value}`);
  }
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
  const activation = options.activate(route.capability).pipe(
    Effect.flatMap((result) =>
      options.resolveBackend === undefined
        ? Effect.succeed(result.endpoint)
        : options
            .resolveBackend(route, view, result)
            .pipe(Effect.mapError((cause) => new GatewayBackendError({ cause }))),
    ),
    Effect.flatMap((backend) =>
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
          target.write(writeUpgrade(request));
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
