import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { GatewayActivationError } from "../public/Errors.ts";
import { connect as connectNet, createServer, type Server, type Socket } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {
  Agent,
  type ClientRequest,
  createServer as createHttpServer,
  request as requestHttp,
  type IncomingMessage,
  type ServerResponse,
  // oxlint-disable-next-line effecttsgo/node-builtin-import
} from "node:http";
import {
  GatewayRouteNotFoundError,
  makeGateway,
  type BackendEndpoint,
  type GatewayRouteRequest,
} from "./Gateway.ts";
import { makeHttpGateway } from "./HttpGateway.ts";
import { makeTcpGateway } from "./TcpGateway.ts";
import type { HostListener } from "../state/PortCoordinator.ts";
import { bindHostListener } from "../supervisor/HostListener.ts";

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) return resume(Effect.void);
    server.close(() => resume(Effect.void));
  });

const getStatus = (port: number, path: string) =>
  Effect.callback<number, Error>((resume) => {
    const request = requestHttp({ host: "127.0.0.1", port, path }, (response) => {
      response.resume();
      response.once("end", () => resume(Effect.succeed(response.statusCode ?? 0)));
    });
    request.once("error", (error) => resume(Effect.fail(error)));
    request.end();
    return Effect.sync(() => request.destroy());
  });

describe("stack gateway", () => {
  it.live("serves local HTTP routes before activation and rejects upgrades", () =>
    withPlatform(
      Effect.gen(function* () {
        let localCalls = 0;
        let activations = 0;
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [
            {
              match: (request) => request.path.startsWith("/email/"),
              localResponse: (request) =>
                request.method === "GET"
                  ? Effect.sync(() => {
                      localCalls += 1;
                      return { body: "template", contentType: "text/plain; charset=utf-8" };
                    })
                  : Effect.fail(new GatewayRouteNotFoundError({ message: "Not found" })),
            },
          ],
          activate: () =>
            Effect.sync(() => {
              activations += 1;
              return { capability: "auth" as const, endpoint: { host: "127.0.0.1", port: 1 } };
            }),
        });
        const response = yield* Effect.callback<{ status: number; body: string }, Error>(
          (resume) => {
            const request = requestHttp(
              { host: "127.0.0.1", port: gateway.port, path: "/email/confirmation.html" },
              (result) => {
                const chunks: Buffer[] = [];
                result.on("data", (chunk: Buffer) => chunks.push(chunk));
                result.once("end", () =>
                  resume(
                    Effect.succeed({
                      status: result.statusCode ?? 0,
                      body: Buffer.concat(chunks).toString(),
                    }),
                  ),
                );
              },
            );
            request.once("error", (error) => resume(Effect.fail(error)));
            request.end();
            return Effect.sync(() => request.destroy());
          },
        );
        expect(response).toEqual({ status: 200, body: "template" });
        expect(localCalls).toBe(1);
        expect(activations).toBe(0);
        const failedMethod = yield* Effect.callback<number, Error>((resume) => {
          const request = requestHttp(
            {
              host: "127.0.0.1",
              port: gateway.port,
              path: "/email/confirmation.html",
              method: "POST",
            },
            (result) => {
              result.resume();
              result.once("end", () => resume(Effect.succeed(result.statusCode ?? 0)));
            },
          );
          request.once("error", (error) => resume(Effect.fail(error)));
          request.end();
          return Effect.sync(() => request.destroy());
        });
        expect(failedMethod).toBe(404);
        expect(localCalls).toBe(1);
        expect(activations).toBe(0);
        yield* Effect.callback<void, Error>((resume) => {
          const socket = connectNet(gateway.port, "127.0.0.1");
          socket.once("connect", () =>
            socket.write(
              "GET /email/confirmation.html HTTP/1.1\r\nHost: gateway.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
            ),
          );
          socket.once("close", () => resume(Effect.void));
          socket.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => socket.destroy());
        });
        expect(localCalls).toBe(1);
        expect(activations).toBe(0);
        yield* gateway.close;
      }),
    ),
  );

  it.live("keeps local routing usable when a client disconnects mid-response", () =>
    withPlatform(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let localCalls = 0;
        let activations = 0;
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [
            {
              match: (request) => request.path.startsWith("/email/"),
              localResponse: () =>
                Effect.gen(function* () {
                  localCalls += 1;
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                  return { body: "template", contentType: "text/plain; charset=utf-8" };
                }),
            },
          ],
          activate: () =>
            Effect.sync(() => {
              activations += 1;
              return { capability: "auth" as const, endpoint: { host: "127.0.0.1", port: 1 } };
            }),
        });
        let request: ClientRequest | undefined;
        const pending = yield* Effect.forkChild(
          Effect.callback<void, Error>((resume) => {
            request = requestHttp(
              { host: "127.0.0.1", port: gateway.port, path: "/email/confirmation.html" },
              (response) => {
                response.resume();
                response.once("end", () => resume(Effect.void));
              },
            );
            request.once("error", () => resume(Effect.void));
            request.end();
            return Effect.sync(() => request?.destroy());
          }),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        request?.destroy();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending).pipe(Effect.exit);
        expect(yield* getStatus(gateway.port, "/email/confirmation.html")).toBe(200);
        expect(localCalls).toBe(2);
        expect(activations).toBe(0);
        yield* gateway.close;
      }),
    ),
  );

  it.live("interrupts lazy activation when the client disconnects before proxying", () =>
    withPlatform(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [{ capability: "rest", match: () => true }],
          activate: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined)));
              return { capability: "rest" as const, endpoint: { host: "127.0.0.1", port: 1 } };
            }),
        });
        let request: ClientRequest | undefined;
        const requestFiber = yield* Effect.forkChild(
          Effect.callback<void, never>((resume) => {
            request = requestHttp(
              { host: "127.0.0.1", port: gateway.port, path: "/rest/v1/items" },
              (response) => response.resume(),
            );
            request.once("error", () => resume(Effect.void));
            request.end();
            return Effect.sync(() => request?.destroy());
          }),
          { startImmediately: true },
        );
        yield* Deferred.await(started);
        request?.destroy();
        yield* Deferred.await(interrupted).pipe(Effect.timeout("5 seconds"));
        yield* Fiber.interrupt(requestFiber);
        yield* gateway.close;
      }),
    ),
  );

  it.live("routes an HTTP request after lazy activation and forwards the response", () =>
    withPlatform(
      Effect.gen(function* () {
        const backend = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
          res.setHeader("x-backend", "yes");
          res.setHeader("x-seen-forwarded-host", req.headers["x-forwarded-host"] ?? "");
          res.setHeader("x-seen-forwarded-proto", req.headers["x-forwarded-proto"] ?? "");
          res.setHeader("x-seen-forwarded-for", req.headers["x-forwarded-for"] ?? "");
          res.end(`${req.method}:${req.url}`);
        });
        yield* Effect.callback<void, Error>((resume) => {
          backend.once("error", (error) => resume(Effect.fail(error)));
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const address = backend.address();
        if (typeof address !== "object" || address === null) return;
        const backendEndpoint: BackendEndpoint = { host: "127.0.0.1", port: address.port };
        const activated: string[] = [];
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [
            {
              capability: "rest",
              match: (request) => request.path.startsWith("/rest"),
              upstreamPath: (request) => `/internal${request.path}`,
            },
            { capability: "database", match: (request) => request.path.startsWith("/db") },
          ],
          activate: (capability) =>
            Effect.sync(() => {
              activated.push(capability);
              return { capability, endpoint: backendEndpoint };
            }),
          resolveBackend: () => Effect.succeed(backendEndpoint),
          cors: { "access-control-allow-origin": "https://example.test" },
        });
        const response = yield* Effect.callback<
          { status: number; body: string; headers: Record<string, string | string[] | undefined> },
          Error
        >((resume) => {
          const req = requestHttp(
            {
              host: "127.0.0.1",
              port: gateway.port,
              path: "/rest/hello?limit=1",
              headers: { host: "api.example.test" },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () =>
                resume(
                  Effect.succeed({
                    status: res.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString(),
                    headers: res.headers,
                  }),
                ),
              );
            },
          );
          req.on("error", (error) => resume(Effect.fail(error)));
          req.end();
          return Effect.sync(() => req.destroy());
        });
        expect(response.status).toBe(200);
        expect(response.body).toBe("GET:/internal/rest/hello?limit=1");
        expect(response.headers["access-control-allow-origin"]).toBe("https://example.test");
        expect(response.headers["x-seen-forwarded-host"]).toBe("api.example.test");
        expect(response.headers["x-seen-forwarded-proto"]).toBe("http");
        expect(String(response.headers["x-seen-forwarded-for"])).toContain("127.0.0.1");
        expect(activated).toEqual(["rest"]);
        yield* closeServer(backend);
      }),
    ),
  );

  it.live("adopts an already-bound native HTTP listener without rebinding", () =>
    withPlatform(
      Effect.gen(function* () {
        const prebound = createHttpServer();
        yield* Effect.callback<void, Error>((resume) => {
          prebound.once("error", (error) => resume(Effect.fail(error)));
          prebound.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const address = prebound.address();
        if (typeof address !== "object" || address === null) return;
        let released = false;
        let releaseCalls = 0;
        const listener: HostListener = {
          field: "api",
          address: "127.0.0.1",
          port: address.port,
          binding: { kind: "http", server: prebound },
          connections: { sockets: new Set() },
          close: Effect.sync(() => {
            released = true;
            releaseCalls += 1;
          }),
        };
        const gateway = yield* makeHttpGateway({
          listener,
          routes: [],
          activate: () => Effect.fail(new GatewayActivationError({ message: "not reached" })),
        });
        expect(gateway.server).toBe(prebound);
        expect(gateway.port).toBe(address.port);
        yield* Effect.all([gateway.close, gateway.close], { concurrency: "unbounded" });
        expect(released).toBe(true);
        expect(releaseCalls).toBe(1);
        expect(prebound.listening).toBe(false);
      }),
    ),
  );

  it.live("closes a socket accepted before HTTP gateway adoption", () =>
    withPlatform(
      Effect.gen(function* () {
        const listener = yield* bindHostListener("127.0.0.1", 0, "api");
        if (listener.binding.kind !== "http") return;
        const server = listener.binding.server;
        const address = server.address();
        if (typeof address !== "object" || address === null) return;
        const accepted = yield* Effect.forkChild(
          Effect.callback<Socket, Error>((resume) => {
            const onConnection = (socket: Socket) => resume(Effect.succeed(socket));
            server.once("connection", onConnection);
            return Effect.sync(() => server.off("connection", onConnection));
          }),
          { startImmediately: true },
        );
        yield* Effect.acquireRelease(
          Effect.callback<Socket, Error>((resume) => {
            const client = connectNet(address.port, "127.0.0.1");
            client.once("connect", () => resume(Effect.succeed(client)));
            client.once("error", (error) => resume(Effect.fail(error)));
            return Effect.sync(() => {
              client.destroy();
            });
          }),
          (client) => Effect.sync(() => client.destroy()),
        );
        const socket = yield* Fiber.join(accepted).pipe(Effect.timeout("5 seconds"));
        const gateway = yield* makeHttpGateway({
          listener,
          routes: [],
          activate: () => Effect.fail(new GatewayActivationError({ message: "not reached" })),
        });
        yield* gateway.close;
        expect(socket.destroyed).toBe(true);
      }),
    ),
  );

  it.live("applies static and prepared header transforms to HTTP and WebSocket upstreams", () =>
    withPlatform(
      Effect.gen(function* () {
        let httpHeaders: IncomingMessage["headers"] | undefined;
        let websocketHeaders: IncomingMessage["headers"] | undefined;
        const backend = createHttpServer((_request, response) => {
          httpHeaders = _request.headers;
          response.end("ok");
        });
        backend.on("upgrade", (request, socket) => {
          websocketHeaders = request.headers;
          socket.end(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          );
        });
        yield* Effect.callback<void, Error>((resume) => {
          backend.once("error", (error) => resume(Effect.fail(error)));
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const address = backend.address();
        if (typeof address !== "object" || address === null) return;
        const endpoint: BackendEndpoint = { host: "127.0.0.1", port: address.port };
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [
            {
              capability: "rest",
              match: (request) => request.path === "/http",
              upstreamHeaders: (_request, headers) => {
                const { "x-remove": _removed, ...rest } = headers;
                return { ...rest, "x-route": "static", "x-forwarded-host": "spoofed" };
              },
            },
            {
              capability: "functions",
              match: (request) => request.path === "/ws",
              prepare: () =>
                Effect.succeed({
                  resolveBackend: () => Effect.succeed(endpoint),
                  upstreamHeaders: (_request, headers) => {
                    const { "x-remove": _removed, ...rest } = headers;
                    return { ...rest, "x-route": "prepared", "x-forwarded-for": "spoofed" };
                  },
                }),
            },
          ],
          activate: (capability) => Effect.succeed({ capability, endpoint }),
        });
        const response = yield* Effect.callback<number, Error>((resume) => {
          const request = requestHttp(
            {
              host: "127.0.0.1",
              port: gateway.port,
              path: "/http",
              headers: {
                host: "gateway.test",
                "x-remove": "client-secret",
                "x-forwarded-host": "client-spoof",
              },
            },
            (result) => {
              result.resume();
              result.once("end", () => resume(Effect.succeed(result.statusCode ?? 0)));
            },
          );
          request.once("error", (error) => resume(Effect.fail(error)));
          request.end();
          return Effect.sync(() => request.destroy());
        });
        expect(response).toBe(200);
        expect(httpHeaders?.["x-remove"]).toBeUndefined();
        expect(httpHeaders?.["x-route"]).toBe("static");
        expect(httpHeaders?.["x-forwarded-host"]).toBe("gateway.test");
        const websocket = yield* Effect.callback<string, Error>((resume) => {
          const socket = connectNet(gateway.port, "127.0.0.1");
          const chunks: Buffer[] = [];
          socket.once("connect", () =>
            socket.write(
              "GET /ws HTTP/1.1\r\nHost: gateway.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-remove: client-secret\r\n\r\n",
            ),
          );
          socket.on("data", (chunk: Buffer) => chunks.push(chunk));
          socket.once("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString())));
          socket.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => socket.destroy());
        });
        expect(websocket).toContain("101 Switching Protocols");
        expect(websocketHeaders?.["x-remove"]).toBeUndefined();
        expect(websocketHeaders?.["x-route"]).toBe("prepared");
        expect(websocketHeaders?.["x-forwarded-for"]).toContain("127.0.0.1");
        yield* gateway.close;
        yield* closeServer(backend);
      }),
    ),
  );

  it.live("closes an idle keep-alive connection it owns", () =>
    withPlatform(
      Effect.gen(function* () {
        const backend = createHttpServer((_request, response) => response.end("ok"));
        yield* Effect.callback<void, Error>((resume) => {
          backend.once("error", (error) => resume(Effect.fail(error)));
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const address = backend.address();
        if (typeof address !== "object" || address === null) return;
        const endpoint: BackendEndpoint = { host: "127.0.0.1", port: address.port };
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [{ capability: "rest", match: () => true }],
          activate: () => Effect.succeed({ capability: "rest", endpoint }),
        });
        const agent = new Agent({ keepAlive: true });
        yield* Effect.callback<void, Error>((resume) => {
          const request = requestHttp(
            { host: "127.0.0.1", port: gateway.port, path: "/", agent },
            (response) => {
              response.resume();
              response.once("end", () => resume(Effect.void));
            },
          );
          request.once("error", (error) => resume(Effect.fail(error)));
          request.end();
          return Effect.sync(() => request.destroy());
        });
        yield* gateway.close;
        expect(gateway.server.listening).toBe(false);
        agent.destroy();
        yield* closeServer(backend);
      }),
    ),
  );

  it.live("adopts a pre-bound TCP listener while preserving half-close", () =>
    withPlatform(
      Effect.gen(function* () {
        const backend = createServer({ allowHalfOpen: true }, (socket) => {
          const chunks: Buffer[] = [];
          socket.on("data", (chunk: Buffer) => chunks.push(chunk));
          socket.once("end", () => socket.end(Buffer.concat(chunks)));
        });
        yield* Effect.callback<void, Error>((resume) => {
          backend.once("error", (error) => resume(Effect.fail(error)));
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const backendAddress = backend.address();
        if (typeof backendAddress !== "object" || backendAddress === null) return;
        const prebound = createServer({ allowHalfOpen: true });
        yield* Effect.callback<void, Error>((resume) => {
          prebound.once("error", (error) => resume(Effect.fail(error)));
          prebound.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const preboundAddress = prebound.address();
        if (typeof preboundAddress !== "object" || preboundAddress === null) return;
        const endpoint: BackendEndpoint = { host: "127.0.0.1", port: backendAddress.port };
        const listener: HostListener = {
          field: "database",
          address: "127.0.0.1",
          port: preboundAddress.port,
          binding: { kind: "tcp", server: prebound, allowHalfOpen: true },
          connections: { sockets: new Set() },
          close: closeServer(prebound),
        };
        const gateway = yield* makeTcpGateway({
          listener,
          routes: [{ capability: "database", match: () => true }],
          activate: () => Effect.succeed({ capability: "database", endpoint }),
        });
        const fixture = Buffer.from("half-close-through-adopted-listener");
        const response = yield* Effect.callback<Buffer, Error>((resume) => {
          const socket = connectNet(gateway.port, "127.0.0.1");
          const chunks: Buffer[] = [];
          socket.once("connect", () => {
            socket.write(fixture);
            socket.end();
          });
          socket.on("data", (chunk: Buffer) => chunks.push(chunk));
          socket.once("end", () => resume(Effect.succeed(Buffer.concat(chunks))));
          socket.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => socket.destroy());
        });
        expect(response.equals(fixture)).toBe(true);
        yield* gateway.close;
        yield* closeServer(backend);
      }),
    ),
  );

  it.live("closes a socket accepted before TCP gateway adoption", () =>
    withPlatform(
      Effect.gen(function* () {
        const listener = yield* bindHostListener("127.0.0.1", 0, "database");
        if (listener.binding.kind !== "tcp") return;
        const server = listener.binding.server;
        const address = server.address();
        if (typeof address !== "object" || address === null) return;
        const accepted = yield* Effect.forkChild(
          Effect.callback<Socket, Error>((resume) => {
            const onConnection = (socket: Socket) => resume(Effect.succeed(socket));
            server.once("connection", onConnection);
            return Effect.sync(() => server.off("connection", onConnection));
          }),
          { startImmediately: true },
        );
        yield* Effect.acquireRelease(
          Effect.callback<Socket, Error>((resume) => {
            const client = connectNet(address.port, "127.0.0.1");
            client.once("connect", () => resume(Effect.succeed(client)));
            client.once("error", (error) => resume(Effect.fail(error)));
            return Effect.sync(() => {
              client.destroy();
            });
          }),
          (client) => Effect.sync(() => client.destroy()),
        );
        const socket = yield* Fiber.join(accepted).pipe(Effect.timeout("5 seconds"));
        const gateway = yield* makeTcpGateway({
          listener,
          routes: [],
          activate: () => Effect.fail(new GatewayActivationError({ message: "not reached" })),
        });
        yield* gateway.close;
        expect(socket.destroyed).toBe(true);
      }),
    ),
  );

  it.live("rolls back an HTTP listener when TCP acquisition fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const httpServer = createHttpServer();
        const badTcpServer = createHttpServer();
        const listen = (server: Server) =>
          Effect.callback<void, Error>((resume) => {
            server.once("error", (error) => resume(Effect.fail(error)));
            server.listen(0, "127.0.0.1", () => resume(Effect.void));
          });
        yield* listen(httpServer);
        yield* listen(badTcpServer);
        const httpAddress = httpServer.address();
        const badTcpAddress = badTcpServer.address();
        if (
          typeof httpAddress !== "object" ||
          httpAddress === null ||
          typeof badTcpAddress !== "object" ||
          badTcpAddress === null
        )
          return;
        const closeNative = (server: Server) => closeServer(server);
        const httpListener: HostListener = {
          field: "api",
          address: "127.0.0.1",
          port: httpAddress.port,
          binding: { kind: "http", server: httpServer },
          connections: { sockets: new Set() },
          close: closeNative(httpServer),
        };
        const badTcpListener: HostListener = {
          field: "database",
          address: "127.0.0.1",
          port: badTcpAddress.port,
          binding: { kind: "http", server: badTcpServer },
          connections: { sockets: new Set() },
          close: closeNative(badTcpServer),
        };
        const result = yield* makeGateway({
          http: [{ field: "api", options: { listener: httpListener, routes: [] } }],
          tcp: [{ field: "database", options: { listener: badTcpListener, routes: [] } }],
          activate: () => Effect.fail(new GatewayActivationError({ message: "not reached" })),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(httpServer.listening).toBe(false);
        expect(badTcpServer.listening).toBe(true);
        yield* closeServer(badTcpServer);
      }),
    ),
  );

  it.live("owns multiple HTTP and TCP listeners keyed by public port field", () =>
    withPlatform(
      Effect.gen(function* () {
        const gateway = yield* makeGateway({
          http: [
            {
              field: "api",
              options: {
                address: "127.0.0.1",
                port: 0,
                routes: [],
              },
            },
            {
              field: "studio",
              options: {
                address: "127.0.0.1",
                port: 0,
                routes: [],
              },
            },
          ],
          tcp: [
            {
              field: "database",
              options: {
                address: "127.0.0.1",
                port: 0,
                routes: [],
              },
            },
            {
              field: "smtp",
              options: {
                address: "127.0.0.1",
                port: 0,
                routes: [],
              },
            },
          ],
          activate: () => Effect.fail(new GatewayActivationError({ message: "not reached" })),
        });
        expect(gateway.http.get("api")?.port).toBeGreaterThan(0);
        expect(gateway.http.get("studio")?.port).toBeGreaterThan(0);
        expect(gateway.tcp.get("database")?.port).toBeGreaterThan(0);
        expect(gateway.tcp.get("smtp")?.port).toBeGreaterThan(0);
        yield* gateway.close;
      }),
    ),
  );

  it.live("preserves HTTP WebSocket upgrades and tunnel bytes", () =>
    withPlatform(
      Effect.gen(function* () {
        const backend = createServer((socket) => {
          let handshake = false;
          let buffered = Buffer.alloc(0);
          socket.on("data", (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (!handshake) {
              const boundary = buffered.indexOf("\r\n\r\n");
              if (boundary < 0) return;
              handshake = true;
              socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
              const remainder = buffered.subarray(boundary + 4);
              if (remainder.byteLength > 0) socket.write(remainder);
              buffered = Buffer.alloc(0);
              return;
            }
            socket.write(chunk);
          });
          socket.once("end", () => socket.destroy());
        });
        yield* Effect.callback<void, Error>((resume) => {
          backend.once("error", (error) => resume(Effect.fail(error)));
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const address = backend.address();
        if (typeof address !== "object" || address === null) return;
        const endpoint: BackendEndpoint = { host: "127.0.0.1", port: address.port };
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [{ capability: "rest", match: () => true }],
          activate: () => Effect.succeed({ capability: "rest", endpoint }),
        });
        const tunneled = yield* Effect.callback<string, Error>((resume) => {
          const socket = connectNet(gateway.port, "127.0.0.1");
          let handshake = false;
          let output = Buffer.alloc(0);
          socket.on("data", (chunk: Buffer) => {
            output = Buffer.concat([output, chunk]);
            if (!handshake && output.includes("\r\n\r\n")) {
              handshake = true;
              socket.write("ws-ping");
            }
            if (handshake && output.includes("ws-ping")) {
              resume(Effect.succeed(output.toString()));
              socket.destroy();
            }
          });
          socket.once("connect", () =>
            socket.write(
              "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
            ),
          );
          socket.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => socket.destroy());
        });
        expect(tunneled).toContain("101 Switching Protocols");
        expect(tunneled).toContain("ws-ping");
        yield* gateway.close;
        yield* closeServer(backend);
      }),
    ),
  );

  it.live("copies TCP bytes transparently", () =>
    withPlatform(
      Effect.gen(function* () {
        const backend = createServer((socket) => {
          socket.on("data", (chunk) => socket.write(chunk));
          socket.once("end", () => socket.end());
        });
        yield* Effect.callback<void, Error>((resume) => {
          backend.once("error", (error) => resume(Effect.fail(error)));
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const address = backend.address();
        if (typeof address !== "object" || address === null) return;
        const endpoint: BackendEndpoint = { host: "127.0.0.1", port: address.port };
        const gateway = yield* makeTcpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [{ capability: "database", match: () => true }],
          activate: () => Effect.succeed({ capability: "database", endpoint }),
          resolveBackend: () => Effect.succeed(endpoint),
        });
        const largeFixture = Buffer.alloc(512 * 1024);
        for (let index = 0; index < largeFixture.byteLength; index += 1)
          largeFixture[index] = (index * 31 + 17) % 256;
        const fixtures = [
          Buffer.from("postgres-bytes"),
          Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2a, 0xff, 0x00]),
          Buffer.from("220 smtp.example ESMTP\r\nSTARTTLS\r\n"),
          Buffer.from("+OK pop3.example\r\nSTLS\r\n"),
          largeFixture,
        ];
        const responses = yield* Effect.forEach(fixtures, (fixture) =>
          Effect.callback<Buffer, Error>((resume) => {
            const socket = connectNet(gateway.port, "127.0.0.1");
            const chunks: Buffer[] = [];
            socket.once("connect", () => socket.end(fixture));
            socket.on("data", (chunk: Buffer) => chunks.push(chunk));
            socket.on("end", () => resume(Effect.succeed(Buffer.concat(chunks))));
            socket.on("error", (error) => resume(Effect.fail(error)));
            return Effect.sync(() => socket.destroy());
          }),
        );
        expect(responses).toEqual(fixtures);
        yield* gateway.close;
        yield* closeServer(backend);
      }),
    ),
  );

  it.live("preserves a backend-initiated TCP half-close", () =>
    withPlatform(
      Effect.gen(function* () {
        let receivedAfterBackendFin = Buffer.alloc(0);
        const backendReceived = yield* Deferred.make<void>();
        const backend = createServer({ allowHalfOpen: true }, (socket) => {
          socket.write("backend-fin");
          socket.end();
          socket.on("data", (chunk) => {
            receivedAfterBackendFin = Buffer.concat([receivedAfterBackendFin, Buffer.from(chunk)]);
            Deferred.doneUnsafe(backendReceived, Effect.void);
          });
        });
        yield* Effect.callback<void, Error>((resume) => {
          backend.once("error", (error) => resume(Effect.fail(error)));
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const address = backend.address();
        if (typeof address !== "object" || address === null) return;
        const endpoint: BackendEndpoint = { host: "127.0.0.1", port: address.port };
        const gateway = yield* makeTcpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [{ capability: "database", match: () => true }],
          activate: () => Effect.succeed({ capability: "database", endpoint }),
          resolveBackend: () => Effect.succeed(endpoint),
        });
        const response = yield* Effect.callback<Buffer, Error>((resume) => {
          const socket = connectNet({ port: gateway.port, host: "127.0.0.1", allowHalfOpen: true });
          const chunks: Buffer[] = [];
          socket.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            if (Buffer.concat(chunks).includes("backend-fin")) socket.end("client-after-fin");
          });
          socket.once("end", () => resume(Effect.succeed(Buffer.concat(chunks))));
          socket.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => socket.destroy());
        });
        expect(response.toString()).toContain("backend-fin");
        yield* Deferred.await(backendReceived);
        expect(receivedAfterBackendFin.toString()).toContain("client-after-fin");
        yield* gateway.close;
        yield* closeServer(backend);
      }),
    ),
  );

  it.live("keeps probes dormant and maps activation/backend failures", () =>
    withPlatform(
      Effect.gen(function* () {
        let activations = 0;
        const route = {
          capability: "rest" as const,
          match: (request: GatewayRouteRequest) => request.path === "/api",
        };
        const dormant = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [route],
          activate: () => {
            activations += 1;
            return Effect.fail(new GatewayActivationError({ message: "should not run" }));
          },
        });
        expect(yield* getStatus(dormant.port, "/health")).toBe(404);
        expect(activations).toBe(0);
        yield* dormant.close;

        const activationFailure = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [route],
          activate: () => Effect.fail(new GatewayActivationError({ message: "activation failed" })),
        });
        expect(yield* getStatus(activationFailure.port, "/api")).toBe(503);
        yield* activationFailure.close;

        const backendFailure = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [route],
          activate: () =>
            Effect.succeed({ capability: "rest", endpoint: { host: "127.0.0.1", port: 1 } }),
          resolveBackend: () =>
            Effect.fail(new GatewayActivationError({ message: "Gateway backend failed" })),
        });
        expect(yield* getStatus(backendFailure.port, "/api")).toBe(503);
        yield* backendFailure.close;

        const tcpFailure = yield* makeTcpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [{ capability: "database", match: () => true }],
          activate: () => Effect.fail(new GatewayActivationError({ message: "activation failed" })),
        });
        const bytesOnActivationFailure = yield* Effect.callback<number, Error>((resume) => {
          const socket = connectNet(tcpFailure.port, "127.0.0.1");
          let bytes = 0;
          socket.on("data", (chunk: Buffer) => (bytes += chunk.byteLength));
          socket.once("close", () => resume(Effect.succeed(bytes)));
          socket.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => socket.destroy());
        });
        expect(bytesOnActivationFailure).toBe(0);
        yield* tcpFailure.close;
      }),
    ),
  );
});
