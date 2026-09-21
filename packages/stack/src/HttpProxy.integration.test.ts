import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Fiber, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { createServer, type Server, type ServerResponse } from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- raw server fixture.
import { Socket } from "node:net"; // oxlint-disable-line effecttsgo/node-builtin-import -- raw disconnect fixture.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- raw WebSocket upgrade fixture.
import { WebSocket, WebSocketServer } from "ws";
import { ProxyError } from "./Proxy.ts";
import { makeHttpProxy, type HttpRoute } from "./HttpProxy.ts";

const listen = (server: Server) =>
  Effect.acquireRelease(
    Effect.callback<{ host: string; port: number }, HttpProxyTestError>((resume) => {
      const onError = (cause: Error) =>
        resume(Effect.fail(new HttpProxyTestError({ message: cause.message, cause })));
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string")
          return resume(Effect.fail(new HttpProxyTestError({ message: "No address" })));
        resume(Effect.succeed({ host: "127.0.0.1", port: address.port }));
      });
      return Effect.sync(() => server.off("error", onError));
    }),
    () =>
      Effect.callback<void, never>((resume) => {
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
  );

class HttpProxyTestError extends Data.TaggedError("HttpProxyTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const request = (port: number, path: string, body: Uint8Array) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`http://127.0.0.1:${port}${path}`).pipe(
        HttpClientRequest.bodyUint8Array(body),
      ),
    );
    return { status: response.status, body: new Uint8Array(yield* response.arrayBuffer) };
  });

it.live("routes streamed HTTP bodies and releases target activity after the response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const body = new Uint8Array(2 * 1024 * 1024).fill(71);
      const backend = createServer((_incoming, outgoing) => {
        _incoming.resume();
        outgoing.writeHead(200);
        outgoing.write(body);
      });
      const backendAddress = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      const acquired = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const route: HttpRoute = {
        id: "echo",
        prefix: "/api",
        target: Effect.acquireRelease(
          Deferred.succeed(acquired, undefined).pipe(Effect.as(backendAddress)),
          () => Deferred.succeed(released, undefined),
        ),
      };
      yield* proxy.setRoutes([route]);
      const heldResponseFiber = yield* Effect.callback<ServerResponse, HttpProxyTestError>(
        (resume) => {
          const onRequest = (_incoming: unknown, outgoing: ServerResponse) =>
            resume(Effect.succeed(outgoing));
          backend.once("request", onRequest);
          return Effect.sync(() => backend.off("request", onRequest));
        },
      ).pipe(Effect.forkScoped);
      const responseFiber = yield* request(proxy.port, "/api/echo", body).pipe(
        Effect.provide(NodeHttpClient.layerNodeHttp),
        Effect.forkScoped,
      );
      yield* Deferred.await(acquired);
      const heldResponse = yield* Fiber.join(heldResponseFiber);
      expect(yield* Deferred.isDone(released)).toBe(false);
      heldResponse?.end(body);
      const response = yield* Fiber.join(responseFiber);
      expect(response.status).toBe(200);
      expect(response.body.byteLength).toBe(body.byteLength * 2);
      expect(response.body.every((value) => value === 71)).toBe(true);
      yield* Deferred.await(released);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps the retained listener and remaining route after one route is removed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = createServer((_request, response) => response.end("first"));
      const second = createServer((request, response) => response.end(request.url));
      const firstAddress = yield* listen(first);
      const secondAddress = yield* listen(second);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      const route = (id: string, prefix: string, address: typeof firstAddress): HttpRoute => ({
        id,
        prefix,
        upstreamPrefix: "/",
        target: Effect.succeed(address),
      });
      yield* proxy.setRoutes([
        route("first", "/one", firstAddress),
        route("second", "/two", secondAddress),
      ]);
      const before = yield* request(proxy.port, "/one", new Uint8Array()).pipe(
        Effect.provide(NodeHttpClient.layerNodeHttp),
      );
      expect(new TextDecoder().decode(before.body)).toBe("first");
      yield* proxy.setRoutes([route("second", "/two", secondAddress)]);
      const after = yield* request(proxy.port, "/two?query=1", new Uint8Array()).pipe(
        Effect.provide(NodeHttpClient.layerNodeHttp),
      );
      expect(new TextDecoder().decode(after.body)).toBe("/?query=1");
      const removed = yield* request(proxy.port, "/one", new Uint8Array()).pipe(
        Effect.provide(NodeHttpClient.layerNodeHttp),
      );
      expect(removed.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("interrupts target acquisition when a waiting client disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const backend = createServer((_request, response) => response.end("unused"));
      const backendAddress = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      const acquired = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      yield* proxy.setRoutes([
        {
          id: "waiting",
          prefix: "/wait",
          target: Effect.gen(function* () {
            const address = yield* Effect.acquireRelease(
              Deferred.succeed(acquired, undefined).pipe(Effect.as(backendAddress)),
              () => Deferred.succeed(released, undefined),
            );
            yield* Deferred.await(gate);
            return address;
          }),
        },
      ]);
      const client = yield* Effect.acquireRelease(
        Effect.callback<Socket, HttpProxyTestError>((resume) => {
          const socket = new Socket();
          const onConnect = () => resume(Effect.succeed(socket));
          const onError = (cause: Error) =>
            resume(Effect.fail(new HttpProxyTestError({ message: cause.message, cause })));
          socket.once("connect", onConnect);
          socket.once("error", onError);
          socket.connect(proxy.port, proxy.host);
          return Effect.sync(() => {
            socket.off("connect", onConnect);
            socket.off("error", onError);
          });
        }),
        (socket) => Effect.sync(() => socket.destroy()),
      );
      yield* Effect.sync(() =>
        client.write("GET /wait HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
      );
      yield* Deferred.await(acquired).pipe(Effect.timeout("5 seconds"));
      yield* Effect.sync(() => client.destroy());
      yield* Deferred.await(released);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("forwards raw WebSocket upgrades, subprotocols, and echo frames", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const backend = createServer();
      const sockets = new WebSocketServer({
        server: backend,
        handleProtocols: (protocols) => (protocols.has("chat") ? "chat" : false),
      });
      let upstreamHost: string | undefined;
      sockets.on("connection", (socket, request) => {
        upstreamHost = request.headers.host;
        socket.on("message", (message) => socket.send(message));
      });
      const backendAddress = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([
        {
          id: "ws",
          prefix: "/socket",
          upstreamHost: "realtime-dev",
          target: Effect.succeed(backendAddress),
        },
      ]);
      const result = yield* Effect.callback<
        { protocol: string; message: string },
        HttpProxyTestError
      >((resume) => {
        const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/socket`, ["chat"]);
        client.once("open", () => client.send("hello"));
        client.once("message", (message) => {
          const text = Array.isArray(message)
            ? Buffer.concat(message).toString()
            : Buffer.isBuffer(message)
              ? message.toString()
              : new TextDecoder().decode(message);
          resume(Effect.succeed({ protocol: client.protocol, message: text }));
          client.close();
        });
        client.once("error", (cause) =>
          resume(Effect.fail(new HttpProxyTestError({ message: cause.message, cause }))),
        );
        return Effect.sync(() => client.close());
      }).pipe(Effect.timeout("10 seconds"));
      expect(result.protocol).toBe("chat");
      expect(result.message).toBe("hello");
      expect(upstreamHost).toBe("realtime-dev");
      yield* Effect.callback<void, HttpProxyTestError>((resume) => {
        sockets.close((cause) =>
          cause === undefined
            ? resume(Effect.void)
            : resume(Effect.fail(new HttpProxyTestError({ message: cause.message, cause }))),
        );
        return Effect.void;
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("overrides the upstream host for HTTP routes when configured", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const backend = createServer((request, response) => {
        response.end(request.headers.host);
      });
      const backendAddress = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([
        {
          id: "http",
          prefix: "/api",
          upstreamHost: "realtime-dev",
          target: Effect.succeed(backendAddress),
        },
      ]);
      const response = yield* request(proxy.port, "/api/health", new Uint8Array()).pipe(
        Effect.provide(NodeHttpClient.layerNodeHttp),
      );
      expect(new TextDecoder().decode(response.body)).toBe("realtime-dev");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("returns a gateway error when a managed target cannot become ready", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([
        {
          id: "failed",
          prefix: "/",
          target: Effect.fail(new ProxyError({ message: "readiness failed" })),
        },
      ]);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`http://127.0.0.1:${proxy.port}/`);
      expect(response.status).toBe(502);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(yield* response.text).toBe("Bad Gateway");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpClient.layerNodeHttp, NodeServices.layer))),
);

it.live("disconnects a pending upstream response when its client closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const backend = createServer();
      const address = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([{ id: "pending", prefix: "/", target: Effect.succeed(address) }]);
      yield* Effect.callback<void, HttpProxyTestError>((resume) => {
        const client = new Socket();
        client.on("error", (cause) =>
          resume(Effect.fail(new HttpProxyTestError({ message: cause.message }))),
        );
        backend.once("request", (_request, response) => {
          response.once("close", () => resume(Effect.void));
          client.destroy();
        });
        client.connect(proxy.port, "127.0.0.1", () =>
          client.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"),
        );
        return Effect.sync(() => client.destroy());
      }).pipe(Effect.timeout("5 seconds"));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("releases a waiting WebSocket target when its client resets the connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      const acquiring = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      yield* proxy.setRoutes([
        {
          id: "socket",
          prefix: "/socket",
          target: Effect.acquireRelease(Deferred.succeed(acquiring, undefined), () =>
            Deferred.succeed(released, undefined),
          ).pipe(Effect.andThen(Effect.never)),
        },
      ]);
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => new Socket()),
        (value) => Effect.sync(() => value.destroy()),
      );
      yield* Effect.callback<void, HttpProxyTestError>((resume) => {
        socket.on("error", (cause) =>
          resume(Effect.fail(new HttpProxyTestError({ message: cause.message }))),
        );
        socket.connect(proxy.port, "127.0.0.1", () => {
          socket.write(
            "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          );
          resume(Effect.void);
        });
        return Effect.void;
      });
      yield* Deferred.await(acquiring);
      yield* Effect.sync(() => socket.resetAndDestroy());
      yield* Deferred.await(released).pipe(Effect.timeout("5 seconds"));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
