import { Data, Effect, FiberSet, Ref, Scope } from "effect";
import { PortError } from "./Ports.ts";
import type { BackendAddress, ProxyError } from "./Proxy.ts";
import {
  createServer,
  request as upstreamRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- raw HTTP upgrade sockets preserve handshake bytes.
import { Socket } from "node:net";
import type { Duplex } from "node:stream";

class HttpProxyError extends Data.TaggedError("HttpProxyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface HttpRoute {
  readonly id: string;
  readonly prefix: string;
  readonly target: Effect.Effect<BackendAddress, ProxyError, Scope.Scope>;
  readonly upstreamPrefix?: string;
  readonly upstreamHost?: string;
}

export interface HttpProxy {
  readonly host: string;
  readonly port: number;
  readonly setRoutes: (routes: ReadonlyArray<HttpRoute>) => Effect.Effect<void>;
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

const errorFor = (cause: unknown) =>
  new HttpProxyError({ message: cause instanceof Error ? cause.message : String(cause), cause });

const headersFor = (headers: IncomingMessage["headers"]) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => value !== undefined && !hopByHop.has(name.toLowerCase()),
    ),
  );

const upstreamHeadersFor = (headers: IncomingMessage["headers"], route: HttpRoute) => ({
  ...headersFor(headers),
  ...(route.upstreamHost === undefined ? {} : { host: route.upstreamHost }),
});

const pathFor = (request: IncomingMessage, route: HttpRoute) => {
  const input = request.url ?? "/";
  if (route.upstreamPrefix === undefined) return input;
  const queryAt = input.indexOf("?");
  const pathname = queryAt < 0 ? input : input.slice(0, queryAt);
  const query = queryAt < 0 ? "" : input.slice(queryAt);
  const suffix = route.prefix === "/" ? pathname : pathname.slice(route.prefix.length);
  return `${route.upstreamPrefix.replace(/\/$/u, "")}${suffix.startsWith("/") ? suffix : `/${suffix}`}${query}`;
};

const pathnameFor = (url: string) => url.split("?", 1)[0] || "/";

const routeFor = (url: string, routes: ReadonlyArray<HttpRoute>) => {
  const pathname = pathnameFor(url);
  return routes.find(
    (route) =>
      pathname === route.prefix || route.prefix === "/" || pathname.startsWith(`${route.prefix}/`),
  );
};

const setCors = (response: ServerResponse, request: IncomingMessage) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    request.headers["access-control-request-headers"] ?? "authorization,apikey,content-type",
  );
};

const disconnected = (request: IncomingMessage, response: ServerResponse) =>
  Effect.callback<never, HttpProxyError>((resume) => {
    const onAbort = () => resume(Effect.fail(errorFor("client disconnected")));
    const onRequestClose = () => {
      if (!request.complete) onAbort();
    };
    const onSocketClose = () => {
      if (!response.writableEnded) onAbort();
    };
    request.once("aborted", onAbort);
    request.once("close", onRequestClose);
    request.socket.once("close", onSocketClose);
    response.once("close", onAbort);
    if (request.aborted || request.socket.destroyed || response.destroyed) onAbort();
    return Effect.sync(() => {
      request.off("aborted", onAbort);
      request.off("close", onRequestClose);
      request.socket.off("close", onSocketClose);
      response.off("close", onAbort);
    });
  });

const connectInterruptibly = Effect.fn("HttpProxy.connect")((address: BackendAddress) =>
  Effect.gen(function* () {
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => new Socket({ allowHalfOpen: true })),
      (value) => Effect.sync(() => value.destroy()),
    );
    yield* Effect.callback<void, HttpProxyError>((resume) => {
      const onConnect = () => resume(Effect.void);
      const onError = (cause: Error) => resume(Effect.fail(errorFor(cause)));
      socket.once("connect", onConnect);
      socket.on("error", onError);
      if ("path" in address) socket.connect(address.path);
      else socket.connect(address.port, address.host);
      return Effect.sync(() => {
        socket.off("connect", onConnect);
      });
    }).pipe(Effect.timeout("10 seconds"));
    return socket;
  }),
);

const proxyRequest = Effect.fn("HttpProxy.proxyRequest")(
  (request: IncomingMessage, response: ServerResponse, route: HttpRoute) =>
    Effect.gen(function* () {
      const backend = yield* Effect.raceFirst(route.target, disconnected(request, response));
      yield* Effect.callback<void, HttpProxyError>((resume) => {
        let outgoing: ReturnType<typeof upstreamRequest> | undefined;
        let incoming: IncomingMessage | undefined;
        let settled = false;
        // Error listeners remain until collection because destroy may emit errors asynchronously.
        const cleanup = () => {
          request.off("aborted", onError);
          response.off("close", onResponseClose);
          response.off("finish", onFinish);

          incoming?.off("aborted", onError);
        };
        const finish = (result: Effect.Effect<void, HttpProxyError>) => {
          if (settled) return;
          settled = true;
          cleanup();
          resume(result);
        };
        const onError = (cause: Error) => {
          if (settled) return;
          outgoing?.destroy();
          incoming?.destroy();
          finish(Effect.fail(errorFor(cause)));
        };
        const onFinish = () => finish(Effect.void);
        const onResponseClose = () => {
          if (!response.writableEnded) onError(new Error("client response closed"));
        };
        outgoing = upstreamRequest(
          {
            host: "path" in backend ? undefined : backend.host,
            port: "path" in backend ? undefined : backend.port,
            socketPath: "path" in backend ? backend.path : undefined,
            method: request.method,
            path: pathFor(request, route),
            headers: upstreamHeadersFor(request.headers, route),
          },
          (value) => {
            incoming = value;
            value.once("aborted", onError);
            value.on("error", onError);
            response.once("finish", onFinish);
            setCors(response, request);
            response.statusCode = value.statusCode ?? 502;
            for (const [name, header] of Object.entries(value.headers)) {
              if (header !== undefined && !hopByHop.has(name.toLowerCase()))
                response.setHeader(name, header);
            }
            value.pipe(response);
          },
        );
        outgoing.on("error", onError);
        request.once("aborted", onError);
        response.once("close", onResponseClose);
        request.pipe(outgoing);
        return Effect.sync(() => {
          settled = true;
          cleanup();
          outgoing?.destroy();
          incoming?.destroy();
        });
      });
    }),
);

const upgrade = Effect.fn("HttpProxy.upgrade")(
  (request: IncomingMessage, client: Duplex, head: Buffer, route: HttpRoute) =>
    Effect.gen(function* () {
      const backend = yield* Effect.raceFirst(
        route.target,
        Effect.callback<never, HttpProxyError>((resume) => {
          const onClose = () => resume(Effect.fail(errorFor("client disconnected")));
          client.once("close", onClose);
          if (client.destroyed) onClose();
          return Effect.sync(() => client.off("close", onClose));
        }),
      );
      const upstream = yield* connectInterruptibly(backend);
      yield* Effect.callback<void, HttpProxyError>((resume) => {
        let settled = false;
        const cleanup = () => {
          client.off("close", onClose);

          upstream.off("close", onClose);
          client.off("end", onClientEnd);
          upstream.off("end", onUpstreamEnd);
        };
        const finish = (result: Effect.Effect<void, HttpProxyError>) => {
          if (settled) return;
          settled = true;
          cleanup();
          resume(result);
        };
        const onError = (cause: Error) => {
          client.destroy();
          upstream.destroy();
          finish(Effect.fail(errorFor(cause)));
        };
        const onClose = () => {
          client.destroy();
          upstream.destroy();
          finish(Effect.void);
        };
        const onClientEnd = () => upstream.end();
        const onUpstreamEnd = () => client.end();
        client.on("error", onError);
        client.once("close", onClose);
        upstream.on("error", onError);
        upstream.once("close", onClose);
        client.once("end", onClientEnd);
        upstream.once("end", onUpstreamEnd);
        const lines = [`${request.method ?? "GET"} ${pathFor(request, route)} HTTP/1.1`];
        for (const [name, value] of Object.entries(upstreamHeadersFor(request.headers, route))) {
          if (value !== undefined)
            lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
        }
        lines.push("Connection: Upgrade", "Upgrade: websocket", "", "");
        upstream.write(lines.join("\r\n"));
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream, { end: false });
        upstream.pipe(client, { end: false });
        return Effect.sync(() => {
          settled = true;
          cleanup();
          client.destroy();
          upstream.destroy();
        });
      });
    }),
);

export const makeHttpProxy = (options: {
  readonly host: string;
  readonly port: number;
}): Effect.Effect<HttpProxy, PortError, Scope.Scope> =>
  Effect.gen(function* () {
    const routes = yield* Ref.make<ReadonlyArray<HttpRoute>>([]);
    const runRequest = yield* FiberSet.makeRuntime();
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      runRequest(
        Effect.scoped(
          Effect.gen(function* () {
            const route = yield* Ref.get(routes).pipe(
              Effect.map((current) => routeFor(request.url ?? "/", current)),
            );
            setCors(response, request);
            if (request.method === "OPTIONS") {
              response.statusCode = 204;
              response.end();
            } else if (route === undefined) {
              response.statusCode = 404;
              response.end("Not Found");
            } else {
              yield* proxyRequest(request, response, route).pipe(
                Effect.catch(() =>
                  Effect.sync(() => {
                    if (response.destroyed) return;
                    if (response.headersSent) response.destroy();
                    else {
                      setCors(response, request);
                      response.statusCode = 502;
                      response.end("Bad Gateway");
                    }
                  }),
                ),
              );
            }
          }),
        ),
      );
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      socket.on("error", () => socket.destroy());
      runRequest(
        Effect.scoped(
          Effect.gen(function* () {
            const route = yield* Ref.get(routes).pipe(
              Effect.map((current) => routeFor(request.url ?? "/", current)),
            );
            if (route === undefined) socket.destroy();
            else
              yield* upgrade(request, socket, head, route).pipe(
                Effect.catch(() => Effect.sync(() => socket.destroy())),
              );
          }),
        ),
      );
    });
    yield* Effect.acquireRelease(
      Effect.callback<void, PortError>((resume) => {
        const onError = (cause: Error) =>
          resume(Effect.fail(new PortError({ key: "http", message: cause.message, cause })));
        server.once("error", onError);
        server.listen(options.port, options.host, () => resume(Effect.void));
        return Effect.sync(() => server.off("error", onError));
      }),
      () =>
        Effect.callback<void, never>((resume) => {
          server.close(() => resume(Effect.void));
          for (const socket of sockets) socket.destroy();
          return Effect.sync(() => server.closeAllConnections?.());
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* new PortError({ key: "http", message: "HTTP listener has no address" });
    return {
      host: address.address,
      port: address.port,
      setRoutes: (next: ReadonlyArray<HttpRoute>) =>
        Ref.set(
          routes,
          [...next].sort((a, b) => b.prefix.length - a.prefix.length),
        ),
    };
  });
