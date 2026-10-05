import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Fiber, Layer, SubscriptionRef } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { createServer, type Server, type ServerResponse } from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- raw server fixture.
import { createServer as createTcpServer, Socket, type Server as NetServer } from "node:net"; // oxlint-disable-line effecttsgo/node-builtin-import -- raw disconnect fixture.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- raw WebSocket upgrade fixture.
import { WebSocket, WebSocketServer } from "ws";
import { captureLogs } from "../tests/logs.ts";
import { ProxyError } from "./Proxy.ts";
import { makeHttpProxy, type HttpRoute } from "./HttpProxy.ts";

const listen = (server: Server | NetServer, options?: { readonly beforeClose?: () => void }) =>
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
        options?.beforeClose?.();
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
  );

class HttpProxyTestError extends Data.TaggedError("HttpProxyTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const captureErrors = captureLogs(["Error"]);
const captureWarnings = captureLogs(["Error", "Warn"]);

/** Upstream that resets its first `drops` accepted connections without responding. */
const droppingBackend = (drops: number) => {
  let connections = 0;
  const server = createServer((_request, response) => response.end("recovered"));
  server.on("connection", (socket) => {
    connections += 1;
    if (connections <= drops) socket.destroy();
  });
  return { server, connections: () => connections };
};

const request = (
  port: number,
  path: string,
  body: Uint8Array,
  headers: Readonly<Record<string, string>> = {},
  method: "GET" | "POST" = "POST",
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const outgoing = Object.entries(headers).reduce(
      (current, [name, value]) => current.pipe(HttpClientRequest.setHeader(name, value)),
      HttpClientRequest.make(method)(`http://127.0.0.1:${port}${path}`).pipe(
        HttpClientRequest.bodyUint8Array(body),
      ),
    );
    const response = yield* client.execute(outgoing);
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

it.live("rewrites an exact-prefix request to the upstream prefix verbatim", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const backend = createServer((request, response) => response.end(request.url));
      const backendAddress = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      const route = (id: string, prefix: string, upstreamPrefix: string): HttpRoute => ({
        id,
        prefix,
        upstreamPrefix,
        target: Effect.succeed(backendAddress),
      });
      yield* proxy.setRoutes([
        route("mcp", "/mcp", "/api/mcp"),
        route("storage-s3", "/storage/v1/s3", "/s3"),
        route("realtime-api", "/realtime/v1/api", "/api"),
      ]);
      const send = (path: string) =>
        request(proxy.port, path, new Uint8Array()).pipe(
          Effect.provide(NodeHttpClient.layerNodeHttp),
        );
      expect(new TextDecoder().decode((yield* send("/mcp")).body)).toBe("/api/mcp");
      expect(new TextDecoder().decode((yield* send("/mcp?read_only=true")).body)).toBe(
        "/api/mcp?read_only=true",
      );
      expect(new TextDecoder().decode((yield* send("/mcp/x")).body)).toBe("/api/mcp/x");
      expect((yield* send("/mcpx")).status).toBe(404);
      expect(new TextDecoder().decode((yield* send("/storage/v1/s3")).body)).toBe("/s3");
      expect(new TextDecoder().decode((yield* send("/realtime/v1/api")).body)).toBe("/api");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("streams a joined MCP route's request and response through the exact upstream path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let seenUrl: string | undefined;
      let seenBody = "";
      const backend = createServer((request, response) => {
        seenUrl = request.url;
        request.on("data", (chunk: Buffer) => (seenBody += chunk.toString()));
        request.on("end", () => {
          response.writeHead(200, { "content-type": "text/plain" });
          response.write("chunk-1");
          response.end("chunk-2");
        });
      });
      const backendAddress = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([
        {
          id: "mcp",
          prefix: "/mcp",
          upstreamPrefix: "/api/mcp",
          target: Effect.succeed(backendAddress),
        },
      ]);
      const response = yield* request(
        proxy.port,
        "/mcp?read_only=true",
        new TextEncoder().encode("mcp-request-body"),
      ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
      expect(seenUrl).toBe("/api/mcp?read_only=true");
      expect(seenBody).toBe("mcp-request-body");
      expect(new TextDecoder().decode(response.body)).toBe("chunk-1chunk-2");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("interrupts target acquisition quietly when a waiting client disconnects", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
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
      expect(logs).toEqual([]);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, captureErrors(logs))));
});

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

it.live("rewrites bearer and sb-api-key headers only on opted-in routes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const backend = createServer((incoming, response) => {
        response.end(
          JSON.stringify({
            authorization: incoming.headers.authorization,
            apikey: incoming.headers.apikey,
            sbApiKey: incoming.headers["sb-api-key"],
          }),
        );
      });
      const backendAddress = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      const keys = {
        publishableKey: "sb_publishable_example",
        secretKey: "sb_secret_example",
        anonKey: "anon.jwt.value",
        serviceRoleKey: "service.role.jwt",
      };
      yield* proxy.setRoutes([
        {
          id: "bearer",
          prefix: "/bearer",
          target: Effect.succeed(backendAddress),
          keyRewrite: { policy: "bearer", keys },
        },
        {
          id: "sb-api-key",
          prefix: "/functions",
          target: Effect.succeed(backendAddress),
          keyRewrite: { policy: "sb-api-key", keys },
        },
        {
          id: "storage-s3",
          prefix: "/storage/v1/s3",
          upstreamPrefix: "/s3",
          target: Effect.succeed(backendAddress),
        },
        {
          id: "storage",
          prefix: "/storage/v1",
          target: Effect.succeed(backendAddress),
          keyRewrite: { policy: "bearer", keys },
        },
        { id: "passthrough", prefix: "/raw", target: Effect.succeed(backendAddress) },
      ]);
      const send = (path: string, headers: Readonly<Record<string, string>>) =>
        request(proxy.port, path, new Uint8Array(), headers).pipe(
          Effect.provide(NodeHttpClient.layerNodeHttp),
          Effect.map(({ body }) => JSON.parse(new TextDecoder().decode(body))),
        );

      expect(
        yield* send("/bearer", {
          authorization: "Bearer sb_publishable_client",
          apikey: keys.publishableKey,
        }),
      ).toEqual({ authorization: "Bearer anon.jwt.value", apikey: keys.publishableKey });
      expect(
        yield* send("/bearer", {
          authorization: "Bearer custom-client-token",
          apikey: keys.secretKey,
        }),
      ).toEqual({ authorization: "Bearer custom-client-token", apikey: keys.secretKey });
      expect(yield* send("/bearer", { apikey: "unrecognized-client-key" })).toEqual({
        authorization: "unrecognized-client-key",
        apikey: "unrecognized-client-key",
      });
      expect(
        yield* send("/functions", {
          authorization: "Bearer sb_secret_client",
          apikey: keys.secretKey,
        }),
      ).toEqual({
        authorization: "Bearer sb_secret_client",
        apikey: keys.secretKey,
        sbApiKey: "Bearer service.role.jwt",
      });
      expect(
        yield* send("/storage/v1/object", {
          authorization: "Bearer sb_secret_client",
          apikey: keys.secretKey,
        }),
      ).toEqual({
        authorization: "Bearer service.role.jwt",
        apikey: keys.secretKey,
      });
      expect(
        yield* send("/storage/v1/s3/bucket/object", {
          authorization: "AWS4-HMAC-SHA256 Credential=client",
          apikey: keys.secretKey,
        }),
      ).toEqual({
        authorization: "AWS4-HMAC-SHA256 Credential=client",
        apikey: keys.secretKey,
      });
      expect(
        yield* send("/raw", {
          authorization: "Bearer sb_publishable_client",
          apikey: keys.publishableKey,
        }),
      ).toEqual({
        authorization: "Bearer sb_publishable_client",
        apikey: keys.publishableKey,
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rewrites only the apikey query value on opted-in WebSocket routes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const backend = createServer();
      const sockets = new WebSocketServer({ server: backend });
      let forwardedAuthorization: string | undefined;
      sockets.on("connection", (socket, request) => {
        forwardedAuthorization = request.headers.authorization;
        socket.send(request.url ?? "/");
      });
      const backendAddress = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([
        {
          id: "realtime",
          prefix: "/realtime",
          target: Effect.succeed(backendAddress),
          keyRewrite: {
            policy: "query",
            keys: {
              publishableKey: "sb_publishable_example",
              secretKey: "sb_secret_example",
              anonKey: "anon.jwt.value",
              serviceRoleKey: "service.role.jwt",
            },
          },
        },
      ]);
      const connect = (query: string) =>
        Effect.callback<string, HttpProxyTestError>((resume) => {
          const client = new WebSocket(
            `ws://127.0.0.1:${proxy.port}/realtime/v1/websocket${query}`,
            { headers: { authorization: "Bearer original-client-token" } },
          );
          client.once("message", (message) => {
            const text = Array.isArray(message)
              ? Buffer.concat(message).toString()
              : Buffer.isBuffer(message)
                ? message.toString()
                : new TextDecoder().decode(message);
            resume(Effect.succeed(text));
            client.close();
          });
          client.once("error", (cause) =>
            resume(Effect.fail(new HttpProxyTestError({ message: cause.message, cause }))),
          );
          return Effect.sync(() => client.close());
        }).pipe(Effect.timeout("10 seconds"));

      const publishableUrl = yield* connect("?apikey=sb_publishable_example&keep=a%20b&other=2");
      expect(publishableUrl).toBe(
        "/realtime/v1/websocket?apikey=anon.jwt.value&keep=a%20b&other=2",
      );
      expect(forwardedAuthorization).toBe("Bearer original-client-token");
      const secretUrl = yield* connect("?apikey=sb_secret_example&keep=a%20b");
      expect(secretUrl).toBe("/realtime/v1/websocket?apikey=service.role.jwt&keep=a%20b");
      const noKeyUrl = yield* connect("?keep=a%20b&other=2");
      expect(noKeyUrl).toBe("/realtime/v1/websocket?keep=a%20b&other=2");
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

it.live("returns a gateway error naming the route and cause when a target cannot wake", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([
        {
          id: "rest",
          prefix: "/",
          target: Effect.fail(new ProxyError({ message: "readiness failed" })),
        },
      ]);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`http://127.0.0.1:${proxy.port}/`);
      expect(response.status).toBe(502);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(yield* response.text).toBe("Bad Gateway");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("Route rest request failed");
      expect(logs[0]).toContain("readiness failed");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(NodeHttpClient.layerNodeHttp, NodeServices.layer, captureErrors(logs)),
    ),
  );
});

it.live("retries a bodyless request once when the upstream drops the connection unanswered", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const backend = droppingBackend(1);
      const address = yield* listen(backend.server);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([{ id: "functions", prefix: "/", target: Effect.succeed(address) }]);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`http://127.0.0.1:${proxy.port}/hello`);
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("recovered");
      expect(backend.connections()).toBe(2);
      // The only log is the retry warning; the masked failure never reaches the error level.
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("Route functions GET upstream failed before responding");
      expect(logs[0]).toMatch(/ECONNRESET|socket hang up/u);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(NodeHttpClient.layerNodeHttp, NodeServices.layer, captureWarnings(logs)),
    ),
  );
});

it.live("does not replay a request with a body when the upstream drops the connection", () => {
  const errors: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const backend = droppingBackend(1);
      const address = yield* listen(backend.server);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([{ id: "functions", prefix: "/", target: Effect.succeed(address) }]);
      const response = yield* request(
        proxy.port,
        "/hello",
        new TextEncoder().encode("payload"),
        {},
        "GET",
      );
      expect(response.status).toBe(502);
      expect(backend.connections()).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Route functions request failed");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(NodeHttpClient.layerNodeHttp, NodeServices.layer, captureErrors(errors)),
    ),
  );
});

/**
 * Keep-alive upstream that answers once per connection and resets any reused connection;
 * connections after `answered` are dropped unanswered.
 */
const oneRequestPerConnectionBackend = (answered = Number.POSITIVE_INFINITY) => {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (connections > answered) {
      socket.destroy();
      return;
    }
    let buffered = Buffer.alloc(0);
    let bodyEnd: number | undefined;
    let replied = false;
    socket.on("data", (chunk: Buffer) => {
      if (replied) {
        socket.resetAndDestroy();
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (bodyEnd === undefined) {
        const headerEnd = buffered.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const contentLength = Number(
          /content-length:\s*(\d+)/iu.exec(
            buffered.subarray(0, headerEnd).toString("latin1"),
          )?.[1] ?? 0,
        );
        bodyEnd = headerEnd + 4 + contentLength;
      }
      if (buffered.length < bodyEnd) return;
      replied = true;
      socket.write("HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok");
    });
  });
  return {
    connections: () => connections,
    listen: listen(server, {
      beforeClose: () => {
        for (const socket of sockets) socket.destroy();
      },
    }),
  };
};

it.live(
  "succeeds a second POST when a keep-alive backend only answers the first request per connection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = oneRequestPerConnectionBackend();
        const address = yield* backend.listen;
        const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
        yield* proxy.setRoutes([{ id: "mcp", prefix: "/", target: Effect.succeed(address) }]);
        const first = yield* request(proxy.port, "/mcp", new TextEncoder().encode("first-body"));
        expect(first.status).toBe(200);
        expect(new TextDecoder().decode(first.body)).toBe("ok");
        const second = yield* request(proxy.port, "/mcp", new TextEncoder().encode("second-body"));
        expect(second.status).toBe(200);
        expect(new TextDecoder().decode(second.body)).toBe("ok");
        expect(backend.connections()).toBe(2);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "retries a GET once on a fresh connection when its pooled connection resets unanswered",
  () => {
    const logs: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = oneRequestPerConnectionBackend();
        const address = yield* backend.listen;
        const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
        yield* proxy.setRoutes([{ id: "studio", prefix: "/", target: Effect.succeed(address) }]);
        const first = yield* request(proxy.port, "/", new Uint8Array(), {}, "GET");
        expect(first.status).toBe(200);
        const second = yield* request(proxy.port, "/", new Uint8Array(), {}, "GET");
        expect(second.status).toBe(200);
        expect(new TextDecoder().decode(second.body)).toBe("ok");
        expect(backend.connections()).toBe(2);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("Route studio GET upstream failed before responding, retrying");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeHttpClient.layerNodeHttp, NodeServices.layer, captureWarnings(logs)),
      ),
    );
  },
);

it.live("returns a gateway error when the fresh retry after a pooled reset also fails", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const backend = oneRequestPerConnectionBackend(1);
      const address = yield* backend.listen;
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([{ id: "studio", prefix: "/", target: Effect.succeed(address) }]);
      const first = yield* request(proxy.port, "/", new Uint8Array(), {}, "GET");
      expect(first.status).toBe(200);
      const second = yield* request(proxy.port, "/", new Uint8Array(), {}, "GET");
      expect(second.status).toBe(502);
      expect(backend.connections()).toBe(2);
      expect(logs).toHaveLength(2);
      expect(logs[0]).toContain("Route studio GET upstream failed before responding, retrying");
      expect(logs[1]).toContain("Route studio request failed");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(NodeHttpClient.layerNodeHttp, NodeServices.layer, captureWarnings(logs)),
    ),
  );
});

it.live("delivers a keyed POST once when the upstream resets after reading its body", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const bodies: Array<string> = [];
      let connections = 0;
      // Answers GETs on a keep-alive connection; resets after reading a POST body in full.
      const backend = createTcpServer((socket) => {
        connections += 1;
        socket.on("error", () => {});
        let buffered = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk]);
          const headerEnd = buffered.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const head = buffered.subarray(0, headerEnd).toString("latin1");
          const bodyEnd = headerEnd + 4 + Number(/content-length:\s*(\d+)/iu.exec(head)?.[1] ?? 0);
          if (buffered.length < bodyEnd) return;
          const body = buffered.subarray(headerEnd + 4, bodyEnd).toString();
          buffered = buffered.subarray(bodyEnd);
          if (head.startsWith("GET ")) {
            socket.write(
              "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok",
            );
            return;
          }
          bodies.push(body);
          socket.resetAndDestroy();
        });
      });
      const address = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([{ id: "rest", prefix: "/", target: Effect.succeed(address) }]);
      const pooled = yield* request(proxy.port, "/rest/v1/", new Uint8Array(), {}, "GET");
      expect(pooled.status).toBe(200);
      const post = yield* request(proxy.port, "/rest/v1/rpc", new TextEncoder().encode("insert"), {
        "idempotency-key": "insert",
      });
      expect(post.status).toBe(502);
      expect(bodies).toEqual(["insert"]);
      expect(connections).toBe(2);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("Route rest request failed");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(NodeHttpClient.layerNodeHttp, NodeServices.layer, captureWarnings(logs)),
    ),
  );
});

it.live("reuses pooled upstream connections across thousands of concurrent requests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let connections = 0;
      const backend = createServer((incoming, outgoing) => {
        incoming.resume();
        incoming.once("end", () => outgoing.end(incoming.url));
      });
      backend.on("connection", () => {
        connections += 1;
      });
      const address = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([{ id: "rest", prefix: "/", target: Effect.succeed(address) }]);
      const responses = yield* Effect.forEach(
        Array.from({ length: 3000 }, (_, index) => index),
        (index) =>
          request(proxy.port, `/rest/v1/items?id=eq.${index}`, new Uint8Array(), {}, "GET").pipe(
            Effect.map((response) => ({
              index,
              status: response.status,
              body: new TextDecoder().decode(response.body),
            })),
          ),
        { concurrency: 16 },
      );
      expect(
        responses.filter(
          ({ index, status, body }) => status !== 200 || body !== `/rest/v1/items?id=eq.${index}`,
        ),
      ).toEqual([]);
      expect(connections).toBeLessThan(100);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "does not replay a bodyless non-idempotent request when the upstream drops the connection",
  () => {
    const errors: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const backend = droppingBackend(1);
        const address = yield* listen(backend.server);
        const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
        yield* proxy.setRoutes([{ id: "functions", prefix: "/", target: Effect.succeed(address) }]);
        const response = yield* request(proxy.port, "/hello", new Uint8Array());
        expect(response.status).toBe(502);
        expect(backend.connections()).toBe(1);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("Route functions request failed");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeHttpClient.layerNodeHttp, NodeServices.layer, captureErrors(errors)),
      ),
    );
  },
);

it.live("gives up after a single retry when the upstream keeps dropping connections", () => {
  const errors: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const backend = droppingBackend(Number.POSITIVE_INFINITY);
      const address = yield* listen(backend.server);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([{ id: "functions", prefix: "/", target: Effect.succeed(address) }]);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`http://127.0.0.1:${proxy.port}/hello`);
      expect(response.status).toBe(502);
      expect(yield* response.text).toBe("Bad Gateway");
      expect(backend.connections()).toBe(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Route functions request failed");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(NodeHttpClient.layerNodeHttp, NodeServices.layer, captureErrors(errors)),
    ),
  );
});

it.live(
  "re-resolves the backend on retry instead of reaching a listener that reused the invalidated address",
  () => {
    const logs: Array<string> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const recovered = createServer((_request, response) => response.end("recovered"));
        const recoveredAddress = yield* listen(recovered);

        let foreignConnections = 0;
        let resolveInvalidated: (() => void) | undefined;
        // One address plays the real backend for the connection that is retried, then the
        // address's next owner for any later one, without an OS-level close/rebind race.
        let role: "backend" | "foreign" = "backend";
        const shared = createTcpServer((socket) => {
          if (role === "backend") {
            role = "foreign";
            socket.destroy();
            resolveInvalidated?.();
          } else {
            foreignConnections += 1;
            socket.destroy();
          }
        });
        const sharedAddress = yield* listen(shared);

        const invalidated = yield* Deferred.make<void>();
        yield* Effect.callback<void, never>((resume) => {
          resolveInvalidated = () => resume(Effect.void);
          return Effect.void;
        }).pipe(Effect.andThen(Deferred.succeed(invalidated, undefined)), Effect.forkScoped);

        let attempts = 0;
        const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
        yield* proxy.setRoutes([
          {
            id: "retry-target",
            prefix: "/",
            target: Effect.gen(function* () {
              attempts += 1;
              if (attempts === 1) return sharedAddress;
              yield* Deferred.await(invalidated);
              return recoveredAddress;
            }),
          },
        ]);

        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(`http://127.0.0.1:${proxy.port}/hello`);
        expect(response.status).toBe(200);
        expect(yield* response.text).toBe("recovered");
        expect(foreignConnections).toBe(0);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain(
          "Route retry-target GET upstream failed before responding, retrying",
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeHttpClient.layerNodeHttp, NodeServices.layer, captureWarnings(logs)),
      ),
    );
  },
);

it.live("closes an upgrade naming the route and cause when a target cannot wake", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([
        {
          id: "realtime",
          prefix: "/socket",
          target: Effect.fail(new ProxyError({ message: "wake failed" })),
        },
      ]);
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => new Socket()),
        (value) => Effect.sync(() => value.destroy()),
      );
      const received: Array<Buffer> = [];
      yield* Effect.callback<void, HttpProxyTestError>((resume) => {
        socket.on("data", (chunk: Buffer) => received.push(chunk));
        // A destroyed upgrade reaches the client as a reset, which closes the socket either way.
        socket.on("error", () => undefined);
        socket.once("close", () => resume(Effect.void));
        socket.connect(proxy.port, "127.0.0.1", () =>
          socket.write(
            "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          ),
        );
        return Effect.void;
      }).pipe(Effect.timeout("5 seconds"));
      expect(Buffer.concat(received)).toHaveLength(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("Route realtime upgrade failed");
      expect(logs[0]).toContain("wake failed");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, captureErrors(logs))));
});

it.live("disconnects a pending upstream response quietly when its client closes", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const backend = createServer();
      const address = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      const released = yield* Deferred.make<void>();
      yield* proxy.setRoutes([
        {
          id: "pending",
          prefix: "/",
          target: Effect.acquireRelease(Effect.succeed(address), () =>
            Deferred.succeed(released, undefined),
          ),
        },
      ]);
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
      yield* Deferred.await(released).pipe(Effect.timeout("5 seconds"));
      expect(logs).toEqual([]);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, captureErrors(logs))));
});

it.live("stays quiet when a client closes after receiving part of the response", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const backend = createServer((incoming, outgoing) => {
        incoming.resume();
        outgoing.writeHead(200, { "content-type": "application/octet-stream" });
        outgoing.write("first-chunk");
      });
      const address = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      const released = yield* Deferred.make<void>();
      yield* proxy.setRoutes([
        {
          id: "streaming",
          prefix: "/",
          target: Effect.acquireRelease(Effect.succeed(address), () =>
            Deferred.succeed(released, undefined),
          ),
        },
      ]);
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => new Socket()),
        (socket) => Effect.sync(() => socket.destroy()),
      );
      yield* Effect.callback<void, HttpProxyTestError>((resume) => {
        // Closing mid-response reaches the client as a reset, which is the disconnect under test.
        client.on("error", () => undefined);
        const onData = (chunk: Buffer) => {
          if (!chunk.includes("first-chunk")) return;
          client.destroy();
          resume(Effect.void);
        };
        client.on("data", onData);
        client.connect(proxy.port, "127.0.0.1", () =>
          client.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"),
        );
        return Effect.sync(() => client.off("data", onData));
      }).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(released).pipe(Effect.timeout("5 seconds"));
      expect(logs).toEqual([]);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, captureErrors(logs))));
});

it.live("releases a waiting WebSocket target quietly when its client resets", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
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
      expect(logs).toEqual([]);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, captureErrors(logs))));
});

const connectRaw = (port: number, host: string) =>
  Effect.acquireRelease(
    Effect.callback<Socket, HttpProxyTestError>((resume) => {
      const socket = new Socket();
      const onConnect = () => resume(Effect.succeed(socket));
      const onError = (cause: Error) =>
        resume(Effect.fail(new HttpProxyTestError({ message: cause.message, cause })));
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.connect(port, host);
      return Effect.sync(() => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      });
    }).pipe(Effect.timeout("5 seconds")),
    (socket) => Effect.sync(() => socket.destroy()),
  );

/** Reads one full HTTP/1.1 response off `socket`: accumulates chunks until the declared body length. */
const readFullResponse = (socket: Socket) =>
  Effect.callback<{ readonly status: number; readonly body: string }, HttpProxyTestError>(
    (resume) => {
      let buffered = Buffer.alloc(0);
      let headerEnd: number | undefined;
      let status = 0;
      let contentLength = 0;
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (headerEnd === undefined) {
          const index = buffered.indexOf("\r\n\r\n");
          if (index === -1) return;
          headerEnd = index + 4;
          const head = buffered.subarray(0, headerEnd).toString("latin1");
          status = Number(/^HTTP\/1\.1 (\d+)/u.exec(head)?.[1] ?? 0);
          contentLength = Number(/content-length:\s*(\d+)/iu.exec(head)?.[1] ?? 0);
        }
        if (buffered.length - headerEnd < contentLength) return;
        socket.off("data", onData);
        resume(
          Effect.succeed({
            status,
            body: buffered.subarray(headerEnd, headerEnd + contentLength).toString(),
          }),
        );
      };
      socket.on("data", onData);
      return Effect.sync(() => socket.off("data", onData));
    },
  ).pipe(Effect.timeout("5 seconds"));

/**
 * Resolves once a fresh connection attempt to `port` is refused rather than served: the listener
 * accepts the TCP handshake but destroys the socket immediately, so no response ever arrives.
 */
const connectionRefused = (port: number, host: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Socket()),
    (socket) => Effect.sync(() => socket.destroy()),
  ).pipe(
    Effect.flatMap((probe) =>
      Effect.callback<boolean, never>((resume) => {
        const onSettled = (responded: boolean) => resume(Effect.succeed(!responded));
        probe.once("error", () => onSettled(false));
        probe.once("close", () => onSettled(false));
        probe.once("data", () => onSettled(true));
        probe.connect(port, host, () =>
          probe.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
        );
        return Effect.void;
      }).pipe(Effect.timeout("5 seconds")),
    ),
  );

it.live(
  "lets a response already in flight when stopAccepting runs finish and deliver its full body",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = createServer((_incoming, outgoing) => {
          outgoing.writeHead(200, { "content-type": "text/plain" });
          outgoing.write("first-chunk");
          // Held open deliberately: the test itself finishes the response, once stopAccepting
          // has already run, so the response's generation crosses the freeze.
        });
        const backendAddress = yield* listen(backend);
        const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
        yield* proxy.setRoutes([
          { id: "api", prefix: "/", target: Effect.succeed(backendAddress) },
        ]);

        const heldResponseFiber = yield* Effect.callback<ServerResponse, HttpProxyTestError>(
          (resume) => {
            const onRequest = (_incoming: unknown, outgoing: ServerResponse) =>
              resume(Effect.succeed(outgoing));
            backend.once("request", onRequest);
            return Effect.sync(() => backend.off("request", onRequest));
          },
        ).pipe(Effect.forkScoped);
        const responseFiber = yield* request(proxy.port, "/", new Uint8Array()).pipe(
          Effect.provide(NodeHttpClient.layerNodeHttp),
          Effect.forkScoped,
        );
        const heldResponse = yield* Fiber.join(heldResponseFiber);

        yield* proxy.stopAccepting;
        expect(yield* connectionRefused(proxy.port, proxy.host)).toBe(true);

        heldResponse?.end("-second-chunk");
        const response = yield* Fiber.join(responseFiber);
        expect(response.status).toBe(200);
        expect(new TextDecoder().decode(response.body)).toBe("first-chunk-second-chunk");
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "closes an idle established connection once stopAccepting runs, while still refusing new connections",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = createServer((_request, response) => response.end("first-response"));
        const backendAddress = yield* listen(backend);
        const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
        yield* proxy.setRoutes([
          { id: "api", prefix: "/", target: Effect.succeed(backendAddress) },
        ]);

        const client = yield* connectRaw(proxy.port, proxy.host);
        client.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
        const first = yield* readFullResponse(client);
        expect(first.status).toBe(200);
        expect(first.body).toBe("first-response");
        // The request already finished, so the connection sits idle with no active work.
        expect(yield* SubscriptionRef.get(proxy.outstandingConnections)).toBe(0);

        const closed = yield* Effect.callback<void, never>((resume) => {
          const onClose = () => resume(Effect.void);
          client.once("close", onClose);
          if (client.destroyed) onClose();
          return Effect.sync(() => client.off("close", onClose));
        }).pipe(Effect.timeout("5 seconds"), Effect.forkScoped);

        yield* proxy.stopAccepting;

        expect(yield* connectionRefused(proxy.port, proxy.host)).toBe(true);
        yield* Fiber.join(closed);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("destroys every established connection immediately when cutAll runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const backend = createServer((_request, response) => response.end("ok"));
      const backendAddress = yield* listen(backend);
      const proxy = yield* makeHttpProxy({ host: "127.0.0.1", port: 0 });
      yield* proxy.setRoutes([{ id: "api", prefix: "/", target: Effect.succeed(backendAddress) }]);

      const client = yield* connectRaw(proxy.port, proxy.host);
      client.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
      const response = yield* readFullResponse(client);
      expect(response.status).toBe(200);
      expect(response.body).toBe("ok");
      // The request already finished, so the connection sits idle with no active work.
      expect(yield* SubscriptionRef.get(proxy.outstandingConnections)).toBe(0);

      const closed = yield* Effect.callback<void, never>((resume) => {
        const onClose = () => resume(Effect.void);
        client.once("close", onClose);
        if (client.destroyed) onClose();
        return Effect.sync(() => client.off("close", onClose));
      }).pipe(Effect.timeout("5 seconds"), Effect.forkScoped);
      yield* proxy.cutAll;
      yield* Fiber.join(closed);
      expect(yield* SubscriptionRef.get(proxy.outstandingConnections)).toBe(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
