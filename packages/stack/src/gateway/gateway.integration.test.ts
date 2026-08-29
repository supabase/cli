import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Redacted } from "effect";
import { GatewayActivationError } from "../public/Errors.ts";
import { connect as connectNet, createServer, type Server } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {
  Agent,
  createServer as createHttpServer,
  request as requestHttp,
  type IncomingMessage,
  type ServerResponse,
  // oxlint-disable-next-line effecttsgo/node-builtin-import
} from "node:http";
import { createLazyActivator, makeGateway, type BackendEndpoint } from "./Gateway.ts";
import { makeHttpGateway } from "./HttpGateway.ts";
import { makeTcpGateway } from "./TcpGateway.ts";
import type { HostListener } from "../state/PortCoordinator.ts";
import { FunctionSettingsDefaults } from "../model/capabilities/functions.ts";
import { makeFunctionsRoot } from "../functions/FunctionsRoot.ts";
import {
  makeFunctionDiscovery,
  makeFunctionsGatewayRoute,
} from "../functions/FunctionDiscovery.ts";

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
        const activator = yield* createLazyActivator({
          generation: 1,
          targets: {
            rest: { dependencies: [] },
            database: { dependencies: [] },
          },
          activate: (capability) =>
            Effect.sync(() => {
              activated.push(capability);
              return { capability, endpoint: backendEndpoint };
            }),
        });
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [
            { capability: "rest", match: (request) => request.path.startsWith("/rest") },
            { capability: "database", match: (request) => request.path.startsWith("/db") },
          ],
          activate: activator.activate,
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
              path: "/rest/hello",
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
        expect(response.body).toBe("GET:/rest/hello");
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
          close: closeNative(httpServer),
        };
        const badTcpListener: HostListener = {
          field: "database",
          address: "127.0.0.1",
          port: badTcpAddress.port,
          binding: { kind: "http", server: badTcpServer },
          close: closeNative(badTcpServer),
        };
        const result = yield* makeGateway({
          http: {
            listener: httpListener,
            routes: [],
          },
          tcp: {
            listener: badTcpListener,
            routes: [],
          },
          activate: () => Effect.fail(new GatewayActivationError({ message: "not reached" })),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(httpServer.listening).toBe(false);
        expect(badTcpServer.listening).toBe(true);
        yield* closeServer(badTcpServer);
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
        const activator = yield* createLazyActivator({
          generation: 2,
          targets: { database: { dependencies: [] } },
          activate: () => Effect.succeed({ capability: "database", endpoint }),
        });
        const gateway = yield* makeTcpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [{ capability: "database", match: () => true }],
          activate: activator.activate,
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
        yield* closeServer(backend);
      }),
    ),
  );

  it.live("keeps probes dormant and maps activation/backend failures", () =>
    withPlatform(
      Effect.gen(function* () {
        let activations = 0;
        const route = { capability: "rest" as const, match: () => true };
        const dormant = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [route],
          activate: () => {
            activations += 1;
            return Effect.fail(new GatewayActivationError({ message: "should not run" }));
          },
        });
        expect(yield* getStatus(dormant.port, "/health")).toBe(200);
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
        expect(yield* getStatus(backendFailure.port, "/api")).toBe(502);
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

  it.live("preflights Functions routes before activation and maps discovery failures", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-functions-gateway-" });
        const functionRoot = `${root}/functions`;
        yield* fs.makeDirectory(`${functionRoot}/rest`, { recursive: true });
        yield* fs.writeFileString(`${functionRoot}/rest/index.ts`, "export default 1");
        const functionsRoot = yield* makeFunctionsRoot({ root: functionRoot });
        let activations = 0;
        const disabledDiscovery = yield* makeFunctionDiscovery({
          root: functionsRoot,
          settings: { rest: { ...FunctionSettingsDefaults, enabled: false } },
        });
        const disabled = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [
            makeFunctionsGatewayRoute(disabledDiscovery, {
              dispatch: (_invocation, activation) => Effect.succeed(activation.endpoint),
            }),
          ],
          activate: () => {
            activations += 1;
            return Effect.succeed({
              capability: "functions",
              endpoint: { host: "127.0.0.1", port: 1 },
            });
          },
        });
        expect(yield* getStatus(disabled.port, "/functions/v1/rest")).toBe(404);
        expect(yield* getStatus(disabled.port, "/functions/v1/missing")).toBe(404);
        expect(activations).toBe(0);
        yield* disabled.close;

        const pathDiscovery = yield* makeFunctionDiscovery({
          root: functionsRoot,
          settings: { rest: { ...FunctionSettingsDefaults, entrypoint: "../outside.ts" } },
        });
        const invalid = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [
            makeFunctionsGatewayRoute(pathDiscovery, {
              dispatch: (_invocation, activation) => Effect.succeed(activation.endpoint),
            }),
          ],
          activate: () => {
            activations += 1;
            return Effect.succeed({
              capability: "functions",
              endpoint: { host: "127.0.0.1", port: 1 },
            });
          },
        });
        expect(yield* getStatus(invalid.port, "/functions/v1/rest")).toBe(503);
        expect(activations).toBe(0);
        yield* invalid.close;

        const backend = createHttpServer((_request, response) => response.end("function-response"));
        backend.on("upgrade", (_request, socket) => {
          socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\nws-response");
        });
        yield* Effect.callback<void, Error>((resume) => {
          backend.once("error", (error) => resume(Effect.fail(error)));
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        const backendAddress = backend.address();
        if (typeof backendAddress !== "object" || backendAddress === null) return;
        const endpoint: BackendEndpoint = { host: "127.0.0.1", port: backendAddress.port };
        yield* fs.makeDirectory(`${functionRoot}/rest/public`, { recursive: true });
        yield* fs.writeFileString(`${functionRoot}/rest/custom.ts`, "export default 1");
        yield* fs.writeFileString(`${functionRoot}/rest/deno.json`, "{}");
        yield* fs.writeFileString(`${functionRoot}/rest/public/file.txt`, "file");
        const dispatched: Array<{
          readonly slug: string;
          readonly entrypoint: string;
          readonly verifyJwt: boolean;
          readonly importMap?: string;
          readonly staticPattern?: string;
          readonly redacted: boolean;
        }> = [];
        const runtimeDiscovery = yield* makeFunctionDiscovery({
          root: functionsRoot,
          settings: {
            rest: {
              ...FunctionSettingsDefaults,
              verify_jwt: false,
              entrypoint: "custom.ts",
              import_map: "deno.json",
              static_files: ["public/*.txt"],
              env: { TOKEN: Redacted.make("opaque-secret") },
            },
          },
        });
        const runtimeGateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [
            makeFunctionsGatewayRoute(runtimeDiscovery, {
              dispatch: (invocation) =>
                Effect.sync(() => {
                  dispatched.push({
                    slug: invocation.slug,
                    entrypoint: invocation.entrypoint.native,
                    verifyJwt: invocation.verifyJwt,
                    ...(invocation.importMap === undefined
                      ? {}
                      : { importMap: invocation.importMap.native }),
                    ...(invocation.staticPatterns[0] === undefined
                      ? {}
                      : { staticPattern: invocation.staticPatterns[0].native }),
                    redacted: Redacted.isRedacted(invocation.env.TOKEN),
                  });
                  return endpoint;
                }),
            }),
          ],
          activate: () => Effect.succeed({ capability: "functions", endpoint }),
        });
        const body = yield* Effect.callback<string, Error>((resume) => {
          const request = requestHttp(
            { host: "127.0.0.1", port: runtimeGateway.port, path: "/functions/v1/rest" },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.once("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString())));
            },
          );
          request.once("error", (error) => resume(Effect.fail(error)));
          request.end();
          return Effect.sync(() => request.destroy());
        });
        expect(body).toBe("function-response");
        const websocket = yield* Effect.callback<string, Error>((resume) => {
          const socket = connectNet(runtimeGateway.port, "127.0.0.1");
          const chunks: Buffer[] = [];
          socket.once("connect", () =>
            socket.write(
              "GET /functions/v1/rest HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
            ),
          );
          socket.on("data", (chunk: Buffer) => chunks.push(chunk));
          socket.once("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString())));
          socket.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => socket.destroy());
        });
        expect(websocket).toContain("101 Switching Protocols");
        expect(websocket).toContain("ws-response");
        expect(dispatched).toHaveLength(2);
        expect(dispatched[0]?.slug).toBe("rest");
        expect(dispatched[0]?.entrypoint).toContain("/rest/custom.ts");
        expect(dispatched[0]?.verifyJwt).toBe(false);
        expect(dispatched[0]?.importMap).toContain("/rest/deno.json");
        expect(dispatched[0]?.staticPattern).toContain("/rest/public/*.txt");
        expect(dispatched[0]?.redacted).toBe(true);
        yield* runtimeGateway.close;
        yield* closeServer(backend);
      }),
    ),
  );
});
