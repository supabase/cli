import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Data, Deferred, Effect, FileSystem, Layer, Path, Ref } from "effect";
import * as Net from "node:net"; // oxlint-disable-line effecttsgo/node-builtin-import -- fixture retains an idle HTTP connection.
import { createServer, type Server } from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- real socket fixture.
import { WebSocket, WebSocketServer } from "ws";
import { get as httpsGet } from "node:https"; // oxlint-disable-line effecttsgo/node-builtin-import -- verifies strict TLS against the local CA.
import { DEFAULT_LOCAL_TLS_CERT, DEFAULT_LOCAL_TLS_KEY } from "./Defaults.ts";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Network from "./Network.ts";
import * as State from "./State.ts";
import { routesFor } from "./host/Routes.ts";

const makeTestState = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );
const makeTestNetwork = (options: {
  readonly stackId: string;
  readonly runtime: Network.NetworkRuntime;
  readonly state: State.Interface;
}) =>
  Layer.build(
    Network.layer({ stackId: options.stackId, runtime: options.runtime }).pipe(
      Layer.provide(Layer.succeed(State.Service, options.state)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, Network.Service)));

const stack = (id: string, port: number | "auto") => ({
  id,
  identity: { projectRoot: "/tmp", branchContext: "test", stackName: id },
  runtime: "native" as const,
  instances: [],
  composition: {},
  ports: port === "auto" ? [] : [{ key: "api", host: "127.0.0.1", port }],
});

class FixtureError extends Data.TaggedError("FixtureError")<{ readonly message: string }> {}

const listen = (server: Server, port = 0) =>
  Effect.acquireRelease(
    Effect.callback<{ host: string; port: number }, FixtureError>((resume) => {
      const onError = (cause: Error) =>
        resume(Effect.fail(new FixtureError({ message: cause.message })));
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string")
          resume(Effect.fail(new FixtureError({ message: "no address" })));
        else resume(Effect.succeed({ host: "127.0.0.1", port: address.port }));
      });
      return Effect.sync(() => server.off("error", onError));
    }),
    () =>
      Effect.callback<void, never>((resume) => {
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
  );

const backend = Effect.acquireRelease(
  Effect.callback<
    { host: string; port: number; server: ReturnType<typeof createServer> },
    FixtureError
  >((resume) => {
    const server = createServer((request, response) => {
      response.end(`backend:${request.url ?? "/"}`);
    });
    const onError = (cause: Error) =>
      resume(Effect.fail(new FixtureError({ message: cause.message })));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        resume(Effect.fail(new FixtureError({ message: "no address" })));
      else resume(Effect.succeed({ host: "127.0.0.1", port: address.port, server }));
    });
    return Effect.sync(() => {
      server.off("error", onError);
      server.close();
    });
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
      return Effect.void;
    }),
);

const request = (
  host: string,
  port: number,
  path: string,
  headers: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const outgoing = Object.entries(headers).reduce(
      (current, [name, value]) => current.pipe(HttpClientRequest.setHeader(name, value)),
      HttpClientRequest.get(`http://${host}:${port}${path}`),
    );
    const response = yield* client.execute(outgoing);
    return yield* response.text;
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));

const endpoint = (target: { host: string; port: number }, enabled: Effect.Effect<boolean>) => ({
  protocol: "http" as const,
  port: "auto" as const,
  backend: Effect.succeed(target),
  enabled,
});

it.live("retains dedicated assignments across network reopen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-retain-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack", "auto"));
      const target = yield* backend;
      const enabled = yield* Ref.make(true);
      const first = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const firstNamespace = yield* first.register({
        id: "one",
        endpoints: { api: endpoint(target, Ref.get(enabled)) },
      });
      yield* firstNamespace.bind;
      const firstAddress = yield* firstNamespace.address("api", "host");
      expect(yield* request(firstAddress.host, firstAddress.port, "/one")).toBe("backend:/one");
      const saved = yield* state.read("stack");
      expect(saved?.ports).toHaveLength(1);
      yield* Ref.set(enabled, false);
      yield* firstNamespace.close;
      yield* firstNamespace.bind;
      expect((yield* firstNamespace.address("api", "host")).port).toBe(firstAddress.port);
      expect(yield* request(firstAddress.host, firstAddress.port, "/restart")).toBe(
        "backend:/restart",
      );
      yield* firstNamespace.close;
      const second = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const secondNamespace = yield* second.register({
        id: "one",
        endpoints: { api: endpoint(target, Ref.get(enabled)) },
      });
      yield* secondNamespace.bind;
      const secondAddress = yield* secondNamespace.address("api", "host");
      expect(secondAddress.port).toBe(firstAddress.port);
      expect(yield* request(secondAddress.host, secondAddress.port, "/reopen")).toBe(
        "backend:/reopen",
      );
      yield* secondNamespace.release;
      expect((yield* state.read("stack"))?.ports).toHaveLength(0);
      expect(yield* fs.exists(path.join(root, "stack", "state.json"))).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const secureRequest = (port: number, path: string) =>
  Effect.callback<string, FixtureError>((resume) => {
    let body = "";
    const request = httpsGet(
      { host: "127.0.0.1", port, path, ca: DEFAULT_LOCAL_TLS_CERT },
      (response) => {
        response.setEncoding("utf8");
        response.on("data", (value: string) => (body += value));
        response.once("end", () => resume(Effect.succeed(body)));
        response.once("error", (cause) =>
          resume(Effect.fail(new FixtureError({ message: cause.message }))),
        );
      },
    );
    request.once("error", (cause) =>
      resume(Effect.fail(new FixtureError({ message: cause.message }))),
    );
    return Effect.sync(() => request.destroy());
  });

it.live("keeps shared routes independent and retains the shared claim", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-shared-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack", "auto"));
      const target = yield* backend;
      const firstEnabled = yield* Ref.make(true);
      const secondEnabled = yield* Ref.make(true);
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const first = yield* network.register({
        id: "rest",
        endpoints: {
          api: {
            ...endpoint(target, Ref.get(firstEnabled)),
            shared: [
              { prefix: "/rest" },
              { prefix: "/realtime/v1/api", upstreamPrefix: "/api" },
              { prefix: "/realtime/v1", upstreamPrefix: "/socket" },
            ],
          },
        },
      });
      const second = yield* network.register({
        id: "auth",
        endpoints: {
          api: { ...endpoint(target, Ref.get(secondEnabled)), shared: [{ prefix: "/auth" }] },
        },
      });
      yield* first.bind;
      yield* second.bind;
      const address = yield* first.address("api", "host");
      expect(yield* request(address.host, address.port, "/rest/v1")).toBe("backend:/rest/v1");
      expect(yield* request(address.host, address.port, "/realtime/v1/websocket?key=one")).toBe(
        "backend:/socket/websocket?key=one",
      );
      expect(yield* request(address.host, address.port, "/realtime/v1/api/health")).toBe(
        "backend:/api/health",
      );
      expect(yield* request(address.host, address.port, "/auth/v1")).toBe("backend:/auth/v1");
      yield* Ref.set(firstEnabled, false);
      yield* first.close;
      expect(yield* request(address.host, address.port, "/auth/v1")).toBe("backend:/auth/v1");
      yield* Ref.set(secondEnabled, false);
      yield* second.close;
      expect((yield* state.read("stack"))?.ports).toHaveLength(1);
      yield* first.bind;
      expect((yield* first.address("api", "host")).port).toBe(address.port);
      expect(yield* request(address.host, address.port, "/rest/reopen")).toBe(
        "backend:/rest/reopen",
      );
      yield* first.close;
      yield* second.release;
      expect((yield* state.read("stack"))?.ports).toHaveLength(1);
      expect(yield* fs.exists(root)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("serves GraphQL, Auth passthrough, discovery, and REST admin on the shared API", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-legacy-routes-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack", "auto"));
      const makeEcho = (service: string) =>
        createServer((incoming, response) =>
          response.end(
            [
              service,
              incoming.url ?? "",
              incoming.headers.authorization ?? "",
              incoming.headers["content-profile"] ?? "",
            ].join("\n"),
          ),
        );
      const restBackend = makeEcho("rest");
      const authBackend = makeEcho("auth");
      const adminBackend = makeEcho("admin");
      const restAddress = yield* listen(restBackend);
      const authAddress = yield* listen(authBackend);
      const adminAddress = yield* listen(adminBackend);
      const keys = {
        publishableKey: "sb_publishable_fixture",
        secretKey: "sb_secret_fixture",
        anonKey: "anon.jwt.fixture",
        serviceRoleKey: "service.role.fixture",
      };
      const restEnabled = yield* Ref.make(true);
      const authEnabled = yield* Ref.make(true);
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const rest = yield* network.register({
        id: "rest",
        endpoints: {
          http: {
            ...endpoint(restAddress, Ref.get(restEnabled)),
            shared: routesFor("rest", "http", keys, () => Effect.succeed(adminAddress)),
          },
        },
      });
      const auth = yield* network.register({
        id: "auth",
        endpoints: {
          http: {
            ...endpoint(authAddress, Ref.get(authEnabled)),
            shared: routesFor("auth", "http", keys, () => Effect.succeed(authAddress)),
          },
        },
      });
      yield* rest.bind;
      yield* auth.bind;
      const address = yield* rest.address("http", "host");

      const graphql = yield* request(address.host, address.port, "/graphql/v1?query=one", {
        authorization: "Bearer sb_secret_client",
        apikey: keys.secretKey,
      });
      expect(graphql.split("\n")).toEqual([
        "rest",
        "/rpc/graphql?query=one",
        "Bearer service.role.fixture",
        "graphql_public",
      ]);
      const explicitProfile = yield* request(address.host, address.port, "/graphql/v1", {
        "content-profile": "private",
      });
      expect(explicitProfile.split("\n")[3]).toBe("private");
      expect(
        (yield* request(address.host, address.port, "/rest-admin/v1/ready")).split("\n"),
      ).toEqual(["admin", "/ready", "", ""]);
      const discovery = yield* request(
        address.host,
        address.port,
        "/.well-known/oauth-authorization-server?tenant=one",
      );
      expect(discovery.split("\n").slice(0, 2)).toEqual([
        "auth",
        "/.well-known/oauth-authorization-server?tenant=one",
      ]);
      for (const path of ["/auth/v1/verify?token=one", "/auth/v1/callback", "/auth/v1/authorize"]) {
        const response = yield* request(address.host, address.port, path, {
          authorization: "Bearer sb_secret_client",
        });
        expect(response.split("\n")[0]).toBe("auth");
        expect(response.split("\n")[2]).toBe("Bearer sb_secret_client");
      }
      yield* Ref.set(restEnabled, false);
      yield* Ref.set(authEnabled, false);
      yield* rest.release;
      yield* auth.release;
      yield* network.release;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps auxiliary listeners on their ports while registering API routes before core", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-aux-routes-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack", "auto"));
      const pgmetaBackend = createServer((incoming, response) =>
        response.end(`pgmeta:${incoming.url ?? "/"}`),
      );
      const pgmetaAddress = yield* listen(pgmetaBackend);
      const poolerBackend = createServer();
      const poolerSockets = new WebSocketServer({ server: poolerBackend });
      poolerSockets.on("connection", (socket, incoming) => socket.send(incoming.url ?? "/"));
      const poolerAddress = yield* listen(poolerBackend);
      const analyticsBackend = createServer((incoming, response) =>
        response.end(`analytics:${incoming.url ?? "/"}`),
      );
      const analyticsAddress = yield* listen(analyticsBackend);
      const studioBackend = createServer((incoming, response) =>
        response.end(`studio:${incoming.url ?? "/"}`),
      );
      const studioAddress = yield* listen(studioBackend);
      const keys = {
        publishableKey: "publishable",
        secretKey: "secret",
        anonKey: "anon",
        serviceRoleKey: "service-role",
      };
      const pgmetaEnabled = yield* Ref.make(true);
      const poolerEnabled = yield* Ref.make(true);
      const analyticsEnabled = yield* Ref.make(true);
      const studioEnabled = yield* Ref.make(true);
      const restEnabled = yield* Ref.make(true);
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const pgmeta = yield* network.register({
        id: "pgmeta",
        endpoints: {
          http: {
            ...endpoint(pgmetaAddress, Ref.get(pgmetaEnabled)),
            routes: routesFor("pgmeta", "http", keys, () => Effect.succeed(pgmetaAddress)),
          },
        },
      });
      const pooler = yield* network.register({
        id: "pooler",
        endpoints: {
          http: {
            ...endpoint(poolerAddress, Ref.get(poolerEnabled)),
            routes: routesFor("pooler", "http", keys, () => Effect.succeed(poolerAddress)),
          },
        },
      });
      const analytics = yield* network.register({
        id: "analytics",
        endpoints: {
          http: {
            ...endpoint(analyticsAddress, Ref.get(analyticsEnabled)),
            routes: routesFor("analytics", "http", keys, () => Effect.succeed(analyticsAddress)),
          },
        },
      });
      const studio = yield* network.register({
        id: "studio",
        endpoints: {
          http: {
            ...endpoint(studioAddress, Ref.get(studioEnabled)),
            routes: routesFor("studio", "http", keys, () => Effect.succeed(studioAddress)),
          },
        },
      });
      yield* pgmeta.bind;
      yield* pooler.bind;
      yield* analytics.bind;
      yield* studio.bind;
      const pgmetaOwnAddress = yield* pgmeta.address("http", "host");
      const poolerOwnAddress = yield* pooler.address("http", "host");
      const analyticsOwnAddress = yield* analytics.address("http", "host");
      const studioOwnAddress = yield* studio.address("http", "host");
      const restBackend = yield* backend;
      const rest = yield* network.register({
        id: "rest",
        endpoints: {
          http: {
            ...endpoint(restBackend, Ref.get(restEnabled)),
            shared: routesFor("rest", "http", keys, () => Effect.succeed(restBackend)),
          },
        },
      });
      yield* rest.bind;
      const apiAddress = yield* rest.address("http", "host");

      expect(pgmetaOwnAddress.port).not.toBe(apiAddress.port);
      expect(poolerOwnAddress.port).not.toBe(apiAddress.port);
      expect(analyticsOwnAddress.port).not.toBe(apiAddress.port);
      expect(studioOwnAddress.port).not.toBe(apiAddress.port);
      expect(yield* request(pgmetaOwnAddress.host, pgmetaOwnAddress.port, "/own")).toBe(
        "pgmeta:/own",
      );
      expect(yield* request(apiAddress.host, apiAddress.port, "/pg?query=one")).toBe(
        "pgmeta:/?query=one",
      );
      expect(yield* request(analyticsOwnAddress.host, analyticsOwnAddress.port, "/own")).toBe(
        "analytics:/own",
      );
      expect(yield* request(apiAddress.host, apiAddress.port, "/analytics/v1?query=one")).toBe(
        "analytics:/?query=one",
      );
      expect(yield* request(studioOwnAddress.host, studioOwnAddress.port, "/own")).toBe(
        "studio:/own",
      );
      expect(yield* request(apiAddress.host, apiAddress.port, "/mcp?query=one")).toBe(
        "studio:/api/mcp?query=one",
      );
      const websocketPath = yield* Effect.callback<string, FixtureError>((resume) => {
        const socket = new WebSocket(
          `ws://${apiAddress.host}:${apiAddress.port}/pooler/v2?tenant=one`,
        );
        socket.once("message", (message) => {
          const value = Array.isArray(message)
            ? Buffer.concat(message).toString()
            : Buffer.isBuffer(message)
              ? message.toString()
              : new TextDecoder().decode(message);
          resume(Effect.succeed(value));
          socket.close();
        });
        socket.once("error", (cause) =>
          resume(Effect.fail(new FixtureError({ message: cause.message }))),
        );
        return Effect.sync(() => socket.close());
      }).pipe(Effect.timeout("10 seconds"));
      expect(websocketPath).toBe("/v2?tenant=one");

      yield* Ref.set(restEnabled, false);
      yield* rest.close;
      const releasedApi = createServer();
      const releasedApiAddress = yield* listen(releasedApi, apiAddress.port);
      expect(releasedApiAddress.port).toBe(apiAddress.port);
      yield* Effect.callback<void, FixtureError>((resume) => {
        releasedApi.close((cause) =>
          cause === undefined
            ? resume(Effect.void)
            : resume(Effect.fail(new FixtureError({ message: cause.message }))),
        );
        return Effect.void;
      });
      expect(yield* request(pgmetaOwnAddress.host, pgmetaOwnAddress.port, "/still-running")).toBe(
        "pgmeta:/still-running",
      );
      yield* rest.bind;
      expect(yield* request(apiAddress.host, apiAddress.port, "/pg?reopened=yes")).toBe(
        "pgmeta:/?reopened=yes",
      );

      yield* Ref.set(pgmetaEnabled, false);
      yield* Ref.set(poolerEnabled, false);
      yield* Ref.set(analyticsEnabled, false);
      yield* Ref.set(studioEnabled, false);
      yield* pgmeta.release;
      yield* pooler.release;
      yield* analytics.release;
      yield* studio.release;
      yield* rest.release;
      yield* network.release;
      yield* Effect.callback<void, FixtureError>((resume) => {
        poolerSockets.close((cause) =>
          cause === undefined
            ? resume(Effect.void)
            : resume(Effect.fail(new FixtureError({ message: cause.message }))),
        );
        return Effect.void;
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("serves HTTPS publicly and keeps the runtime gateway plain HTTP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-gateway-tls-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack", "auto"));
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      expect((yield* state.read("stack"))?.ports).toEqual([]);
      const configured = yield* network.gateway.configure({
        tls: { cert: DEFAULT_LOCAL_TLS_CERT, key: DEFAULT_LOCAL_TLS_KEY },
        port: "auto",
      });
      const saved = yield* state.read("stack");
      expect(saved?.gateway?.tls).toEqual({
        cert: DEFAULT_LOCAL_TLS_CERT,
        key: DEFAULT_LOCAL_TLS_KEY,
      });
      expect(saved?.ports.map(({ key }) => key)).toEqual(["api", "api-runtime"]);
      expect(configured.hostUrl).toMatch(/^https:\/\/127\.0\.0\.1:/u);
      expect(configured.runtimeUrl).toMatch(/^http:\/\/127\.0\.0\.1:/u);

      const target = yield* backend;
      const enabled = yield* Ref.make(true);
      const namespace = yield* network.register({
        id: "rest",
        endpoints: {
          http: {
            ...endpoint(target, Ref.get(enabled)),
            shared: [{ prefix: "/api" }],
          },
        },
      });
      const otherEnabled = yield* Ref.make(true);
      const otherNamespace = yield* network.register({
        id: "auth",
        endpoints: {
          http: {
            ...endpoint(target, Ref.get(otherEnabled)),
            shared: [{ prefix: "/other" }],
          },
        },
      });
      yield* namespace.bind;
      yield* otherNamespace.bind;
      const hostAddress = yield* namespace.address("http", "host");
      const runtimeAddress = yield* namespace.address("http", "runtime");
      const otherRuntimeAddress = yield* otherNamespace.address("http", "runtime");
      expect(hostAddress.protocol).toBe("https");
      expect((yield* namespace.bindings).map(({ protocol }) => protocol)).toContain("https");
      expect(yield* secureRequest(hostAddress.port, "/api/public?source=tls")).toBe(
        "backend:/api/public?source=tls",
      );
      expect(
        yield* request(runtimeAddress.host, runtimeAddress.port, "/api/runtime?plain=yes"),
      ).toBe("backend:/api/runtime?plain=yes");
      expect(yield* secureRequest(hostAddress.port, "/other/retained")).toBe(
        "backend:/other/retained",
      );
      expect(
        yield* request(otherRuntimeAddress.host, otherRuntimeAddress.port, "/other/retained"),
      ).toBe("backend:/other/retained");
      expect(
        yield* network.gateway.configure({
          tls: { cert: DEFAULT_LOCAL_TLS_CERT, key: DEFAULT_LOCAL_TLS_KEY },
          port: hostAddress.port,
        }),
      ).toEqual(configured);
      const changedWhileActive = yield* network.gateway
        .configure({ port: "auto" })
        .pipe(Effect.flip);
      expect(changedWhileActive.operation).toBe("gateway.configure");

      yield* Ref.set(enabled, false);
      yield* namespace.close;
      expect(yield* secureRequest(hostAddress.port, "/api/removed")).toBe("Not Found");
      expect(yield* request(runtimeAddress.host, runtimeAddress.port, "/api/removed")).toBe(
        "Not Found",
      );
      expect(yield* secureRequest(hostAddress.port, "/other/still-present")).toBe(
        "backend:/other/still-present",
      );
      expect(
        yield* request(otherRuntimeAddress.host, otherRuntimeAddress.port, "/other/still-present"),
      ).toBe("backend:/other/still-present");
      yield* namespace.release;

      yield* Ref.set(otherEnabled, false);
      yield* otherNamespace.close;
      const probe = createServer();
      const released = yield* listen(probe, hostAddress.port);
      expect(released.port).toBe(hostAddress.port);
      yield* Effect.callback<void, FixtureError>((resume) => {
        probe.close((cause) =>
          cause === undefined
            ? resume(Effect.void)
            : resume(Effect.fail(new FixtureError({ message: cause.message }))),
        );
        return Effect.void;
      });
      yield* otherNamespace.bind;
      expect(yield* secureRequest(hostAddress.port, "/other/reopened")).toBe(
        "backend:/other/reopened",
      );
      expect(
        yield* request(otherRuntimeAddress.host, otherRuntimeAddress.port, "/other/reopened"),
      ).toBe("backend:/other/reopened");
      yield* otherNamespace.close;
      yield* otherNamespace.release;

      const plain = yield* network.gateway.configure({ port: "auto" });
      expect(plain.hostUrl).toMatch(/^http:\/\/127\.0\.0\.1:/u);
      expect(plain.runtimeUrl).toBe(plain.hostUrl);
      expect((yield* state.read("stack"))?.ports.map(({ key }) => key)).toEqual(["api"]);
      yield* network.release;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports a dedicated port conflict without rewriting saved ownership", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-conflict-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("first", "auto"));
      yield* state.save(stack("second", 20001));
      const target = yield* backend;
      const firstEnabled = yield* Ref.make(true);
      const firstNetwork = yield* makeTestNetwork({ stackId: "first", runtime: "native", state });
      const first = yield* firstNetwork.register({
        id: "db",
        endpoints: { sql: { ...endpoint(target, Ref.get(firstEnabled)), protocol: "tcp" } },
      });
      yield* first.bind;
      const firstPort = (yield* first.address("sql", "host")).port;
      const secondEnabled = yield* Ref.make(true);
      const secondNetwork = yield* makeTestNetwork({ stackId: "second", runtime: "native", state });
      const second = yield* secondNetwork.register({
        id: "db",
        endpoints: {
          sql: {
            ...endpoint(target, Ref.get(secondEnabled)),
            protocol: "tcp",
            port: firstPort,
          },
        },
      });
      const failure = yield* second.bind.pipe(Effect.flip);
      expect(failure.operation).toBe("bind");
      expect((yield* state.read("second"))?.ports).toEqual([
        { key: "api", host: "127.0.0.1", port: 20001 },
      ]);
      yield* Ref.set(firstEnabled, false);
      yield* first.release;
      yield* Ref.set(secondEnabled, false);
      yield* second.release;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("can bind a shared listener after saving its first assignment failed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-save-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack", "auto"));
      const failing = yield* Ref.make(true);
      const network = yield* makeTestNetwork({
        stackId: "stack",
        runtime: "native",
        state: {
          ...state,
          save: (value) =>
            Ref.get(failing).pipe(
              Effect.flatMap((fail) =>
                fail
                  ? Effect.fail(
                      new State.StateError({ operation: "save", message: "write failed" }),
                    )
                  : state.save(value),
              ),
            ),
        },
      });
      const target = yield* backend;
      const namespace = yield* network.register({
        id: "rest",
        endpoints: {
          api: { ...endpoint(target, Effect.succeed(false)), shared: [{ prefix: "/rest" }] },
        },
      });
      yield* namespace.bind.pipe(Effect.flip);
      yield* Ref.set(failing, false);
      yield* namespace.bind;
      const address = yield* namespace.address("api", "host");
      expect(yield* request(address.host, address.port, "/rest")).toBe("backend:/rest");
      yield* namespace.release;
      yield* network.release;
      expect((yield* state.read("stack"))?.ports).toHaveLength(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("releases dedicated HTTP activity after the response while keep-alive stays open", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-http-activity-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack", "auto"));
      const target = yield* backend;
      const released = yield* Deferred.make<void>();
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const service = yield* network.register({
        id: "studio",
        endpoints: {
          http: {
            ...endpoint(target, Effect.succeed(true)),
            backend: Effect.acquireRelease(Effect.succeed(target), () =>
              Deferred.succeed(released, undefined),
            ),
          },
        },
      });
      yield* service.bind;
      const address = yield* service.address("http", "host");
      const socket = yield* Effect.acquireRelease(
        Effect.callback<Net.Socket, FixtureError>((resume) => {
          const connection = Net.createConnection({ host: address.host, port: address.port });
          connection.once("connect", () => resume(Effect.succeed(connection)));
          connection.on("error", (cause) =>
            resume(Effect.fail(new FixtureError({ message: cause.message }))),
          );
          return Effect.sync(() => connection.destroy());
        }),
        (connection) =>
          Effect.sync(() => {
            connection.destroy();
          }),
      );
      yield* Effect.callback<void, FixtureError>((resume) => {
        let text = "";
        const onData = (bytes: Buffer) => {
          text += bytes.toString();
          if (text.includes("backend:/hello")) resume(Effect.void);
        };
        socket.on("data", onData);
        socket.write("GET /hello HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
        return Effect.sync(() => socket.off("data", onData));
      });
      expect(socket.destroyed).toBe(false);
      yield* Deferred.await(released).pipe(Effect.timeout("2 seconds"));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
