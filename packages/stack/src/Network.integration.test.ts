import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Data, Deferred, Effect, Fiber, FileSystem, Hash, Layer, Path, Ref } from "effect";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import * as Net from "node:net"; // oxlint-disable-line effecttsgo/node-builtin-import -- fixture retains an idle HTTP connection.
import * as Tls from "node:tls";
import { createServer, type RequestListener } from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- real socket fixture.
import { HttpBody, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeHttpProxy, type HttpAccess, type HttpAccessSink } from "./HttpProxy.ts";
import * as Network from "./Network.ts";
import * as PortReservations from "./namespace/PortReservations.ts";
import * as Ports from "./Ports.ts";
import { DOCKER_HOST_ALIAS } from "./runtime/Container.ts";
import { plainPeerAllowed, type ApiTlsNetwork } from "./runtime/ApiTlsSupport.ts";
import { emailTemplateFile, freshWrites, joinRoutes, sharedRoutes } from "./host/Endpoints.ts";
import { readResolvedFile } from "./namespace/drivers/FileSystem.ts";
import type { ServiceCreation } from "./services/Catalog.ts";
import * as StackNamespace from "./StackNamespace.ts";
import { selection } from "../tests/pins.ts";
import { captureLogs } from "../tests/logs.ts";

const makeTestState = (root: string) =>
  Layer.build(StackNamespace.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, StackNamespace.Service)),
  );
const makeTestNetwork = (options: {
  readonly stackId: string;
  readonly runtime: Network.NetworkRuntime;
  readonly state: StackNamespace.Interface;
  readonly onAccess?: HttpAccessSink | undefined;
  readonly hostAddresses?: () => ReadonlySet<string>;
}) =>
  Layer.build(
    Network.layer({
      stackId: options.stackId,
      runtime: options.runtime,
      ...(options.onAccess === undefined ? {} : { onAccess: options.onAccess }),
      ...(options.hostAddresses === undefined ? {} : { hostAddresses: options.hostAddresses }),
    }).pipe(Layer.provide(Layer.succeed(StackNamespace.Service, options.state))),
  ).pipe(Effect.map((context) => Context.get(context, Network.Service)));

const stack = (id: string) => ({
  id,
  identity: { projectRoot: "/tmp", branchContext: "test", stackName: id },
  runtime: "native" as const,
  lifetime: "detached" as const,
  instances: [],
  composition: { members: [], dependencies: [] },
});

/** The port the machine-wide registry holds for this stack's endpoint key, if any. */
const reservedPort = (root: string, stackId: string, key: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const registry = yield* PortReservations.Service;
    return yield* registry.find(yield* fs.realPath(root), stackId, key);
  }).pipe(Effect.provide(PortReservations.layer));

class FixtureError extends Data.TaggedError("FixtureError")<{ readonly message: string }> {}

const backendWith = (handler: RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<
      { host: string; port: number; server: ReturnType<typeof createServer> },
      FixtureError
    >((resume) => {
      const server = createServer(handler);
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

const backend = backendWith((request, response) => {
  response.end(`backend:${request.url ?? "/"}`);
});

const request = (host: string, port: number, path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`http://${host}:${port}${path}`);
    return yield* response.text;
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));

const endpoint = (target: { host: string; port: number }, enabled: Effect.Effect<boolean>) => ({
  protocol: "http" as const,
  port: "auto" as const,
  backend: Effect.succeed(target),
  enabled,
});

/** A dedicated HTTP endpoint that additionally joins the shared API listener, like Studio's `http`. */
const joinEndpoint = (target: { host: string; port: number }, enabled: Effect.Effect<boolean>) => ({
  ...endpoint(target, enabled),
  join: [{ prefix: "/mcp", upstreamPrefix: "/api/mcp" }],
});

const claimant = (
  id: string,
  target: { host: string; port: number },
  enabled: Effect.Effect<boolean>,
  port: number | "auto" = "auto",
) => ({
  id,
  endpoints: { api: { ...endpoint(target, enabled), port, shared: [{ prefix: "/rest" }] } },
});

it.live("retains dedicated assignments across network reopen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-retain-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
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
      expect(yield* reservedPort(root, "stack", "one:api")).toBe(firstAddress.port);
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
      expect(yield* reservedPort(root, "stack", "one:api")).toBe(firstAddress.port);
      yield* secondNamespace.releasePorts;
      expect(yield* reservedPort(root, "stack", "one:api")).toBeUndefined();
      expect(yield* fs.exists(path.join(root, "stack", "state.json"))).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps shared routes independent and retains the shared claim", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-shared-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
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
      expect(yield* reservedPort(root, "stack", "api")).toBe(address.port);
      yield* first.bind;
      expect((yield* first.address("api", "host")).port).toBe(address.port);
      expect(yield* request(address.host, address.port, "/rest/reopen")).toBe(
        "backend:/rest/reopen",
      );
      yield* first.close;
      yield* second.release;
      yield* second.releasePorts;
      expect(yield* reservedPort(root, "stack", "api")).toBe(address.port);
      expect(yield* fs.exists(root)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports a dedicated port conflict without taking over the holder's reservation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-conflict-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("first"));
      yield* state.save(stack("second"));
      yield* state.acquireLease("first");
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
      expect(yield* reservedPort(root, "first", "db:sql")).toBe(firstPort);
      expect(yield* reservedPort(root, "second", "db:sql")).toBeUndefined();
      yield* Ref.set(firstEnabled, false);
      yield* first.release;
      yield* first.releasePorts;
      yield* Ref.set(secondEnabled, false);
      yield* second.release;
      yield* second.releasePorts;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("releases dedicated HTTP activity after the response while keep-alive stays open", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-http-activity-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
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

it.live(
  "queues a joined route before any claimant binds, then serves it on the claimant's own port",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-join-fixed-port-" });
        const state = yield* makeTestState(root);
        yield* state.save(stack("stack"));
        const target = yield* backend;
        const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
        const studio = yield* network.register({
          id: "studio",
          endpoints: { http: joinEndpoint(target, Effect.succeed(true)) },
        });
        yield* studio.bind;
        // The join route is queued, not installed: it never claims or asserts the shared "api"
        // port, so no shared listener or claim exists yet, whatever port a later claimant picks.
        expect(yield* reservedPort(root, "stack", "api")).toBeUndefined();
        const rest = yield* network.register(claimant("rest", target, Effect.succeed(true)));
        yield* rest.bind;
        const address = yield* rest.address("api", "host");
        expect(yield* request(address.host, address.port, "/mcp?read_only=true")).toBe(
          "backend:/api/mcp?read_only=true",
        );
        expect(yield* request(address.host, address.port, "/rest")).toBe("backend:/rest");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("drops a queued join route when its namespace closes before any claimant binds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-join-cancel-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const target = yield* backend;
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const studio = yield* network.register({
        id: "studio",
        endpoints: { http: joinEndpoint(target, Effect.succeed(false)) },
      });
      yield* studio.bind;
      yield* studio.close;
      const rest = yield* network.register(claimant("rest", target, Effect.succeed(true)));
      yield* rest.bind;
      const address = yield* rest.address("api", "host");
      const response = yield* HttpClient.HttpClient.pipe(
        Effect.flatMap((client) => client.get(`http://${address.host}:${address.port}/mcp`)),
        Effect.provide(NodeHttpClient.layerNodeHttp),
      );
      expect(response.status).toBe(404);
      expect(yield* request(address.host, address.port, "/rest")).toBe("backend:/rest");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("stays idempotent across repeated binds of the joining namespace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-join-idempotent-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const target = yield* backend;
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const rest = yield* network.register(claimant("rest", target, Effect.succeed(true)));
      yield* rest.bind;
      const studio = yield* network.register({
        id: "studio",
        endpoints: { http: joinEndpoint(target, Effect.succeed(true)) },
      });
      yield* studio.bind;
      yield* studio.bind;
      yield* studio.bind;
      const address = yield* rest.address("api", "host");
      expect(yield* request(address.host, address.port, "/mcp")).toBe("backend:/api/mcp");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps a namespace's own shared route when its join endpoint also binds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "network-join-shares-namespace-",
      });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const target = yield* backend;
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const combo = yield* network.register({
        id: "combo",
        endpoints: {
          api: { ...endpoint(target, Effect.succeed(true)), shared: [{ prefix: "/rest" }] },
          http: joinEndpoint(target, Effect.succeed(true)),
        },
      });
      yield* combo.bind;
      const address = yield* combo.address("api", "host");
      expect(yield* request(address.host, address.port, "/rest")).toBe("backend:/rest");
      expect(yield* request(address.host, address.port, "/mcp")).toBe("backend:/api/mcp");
      yield* combo.bind;
      expect(yield* request(address.host, address.port, "/rest")).toBe("backend:/rest");
      expect(yield* request(address.host, address.port, "/mcp")).toBe("backend:/api/mcp");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("re-adds a joined route after its namespace closes and rebinds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-join-rebind-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const target = yield* backend;
      const enabled = yield* Ref.make(true);
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const rest = yield* network.register(claimant("rest", target, Effect.succeed(true)));
      yield* rest.bind;
      const studio = yield* network.register({
        id: "studio",
        endpoints: { http: joinEndpoint(target, Ref.get(enabled)) },
      });
      yield* studio.bind;
      const address = yield* rest.address("api", "host");
      expect(yield* request(address.host, address.port, "/mcp")).toBe("backend:/api/mcp");
      yield* Ref.set(enabled, false);
      yield* studio.close;
      const closedResponse = yield* HttpClient.HttpClient.pipe(
        Effect.flatMap((client) => client.get(`http://${address.host}:${address.port}/mcp`)),
        Effect.provide(NodeHttpClient.layerNodeHttp),
      );
      expect(closedResponse.status).toBe(404);
      yield* Ref.set(enabled, true);
      yield* studio.bind;
      expect(yield* request(address.host, address.port, "/mcp")).toBe("backend:/api/mcp");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("never restores a joined route once its namespace is released", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-join-release-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const target = yield* backend;
      const enabled = yield* Ref.make(true);
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const rest = yield* network.register(claimant("rest", target, Effect.succeed(true)));
      yield* rest.bind;
      const studio = yield* network.register({
        id: "studio",
        endpoints: { http: joinEndpoint(target, Ref.get(enabled)) },
      });
      yield* studio.bind;
      const address = yield* rest.address("api", "host");
      expect(yield* request(address.host, address.port, "/mcp")).toBe("backend:/api/mcp");
      yield* Ref.set(enabled, false);
      yield* studio.release;
      const failure = yield* studio.bind.pipe(Effect.flip);
      expect(failure.operation).toBe("bind");
      const releasedResponse = yield* HttpClient.HttpClient.pipe(
        Effect.flatMap((client) => client.get(`http://${address.host}:${address.port}/mcp`)),
        Effect.provide(NodeHttpClient.layerNodeHttp),
      );
      expect(releasedResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "keeps a joined route working after the last claimant closes and closes the listener once it is gone too",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-join-last-close-" });
        const state = yield* makeTestState(root);
        yield* state.save(stack("stack"));
        const target = yield* backend;
        const restEnabled = yield* Ref.make(true);
        const studioEnabled = yield* Ref.make(true);
        const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
        const rest = yield* network.register(claimant("rest", target, Ref.get(restEnabled)));
        yield* rest.bind;
        const studio = yield* network.register({
          id: "studio",
          endpoints: { http: joinEndpoint(target, Ref.get(studioEnabled)) },
        });
        yield* studio.bind;
        const address = yield* rest.address("api", "host");
        expect(yield* request(address.host, address.port, "/mcp")).toBe("backend:/api/mcp");
        yield* Ref.set(restEnabled, false);
        yield* rest.close;
        expect(yield* request(address.host, address.port, "/mcp")).toBe("backend:/api/mcp");
        expect(
          (yield* HttpClient.HttpClient.pipe(
            Effect.flatMap((client) => client.get(`http://${address.host}:${address.port}/rest`)),
            Effect.provide(NodeHttpClient.layerNodeHttp),
          )).status,
        ).toBe(404);
        // A served keep-alive request proves the listener accepted and tracks this socket, so its
        // closure is observed directly instead of by reprobing the port.
        const probe = yield* Effect.callback<Net.Socket, FixtureError>((resume) => {
          const connection = Net.createConnection({ host: address.host, port: address.port });
          connection.once("connect", () => {
            connection.write(
              `GET /mcp HTTP/1.1\r\nHost: ${address.host}:${address.port}\r\nConnection: keep-alive\r\n\r\n`,
            );
          });
          connection.once("data", () => resume(Effect.succeed(connection)));
          connection.on("error", (cause) =>
            resume(Effect.fail(new FixtureError({ message: cause.message }))),
          );
          return Effect.sync(() => connection.destroy());
        });
        const probeClosed = yield* Effect.callback<void, never>((resume) => {
          probe.once("close", () => resume(Effect.void));
          return Effect.sync(() => probe.destroy());
        }).pipe(Effect.forkChild);
        yield* Ref.set(studioEnabled, false);
        yield* studio.close;
        yield* Fiber.join(probeClosed).pipe(Effect.timeout("2 seconds"));
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("wakes a sleeping backend when a request reaches its joined route", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-join-wake-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const target = yield* backend;
      const woken = yield* Deferred.make<void>();
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const rest = yield* network.register(claimant("rest", target, Effect.succeed(true)));
      yield* rest.bind;
      const studio = yield* network.register({
        id: "studio",
        endpoints: {
          http: {
            ...joinEndpoint(target, Effect.succeed(true)),
            // Mirrors the orchestrator's acquire-then-resolve path: the target effect itself wakes
            // the instance on demand instead of pointing at an already-running backend.
            backend: Deferred.succeed(woken, undefined).pipe(Effect.as(target)),
          },
        },
      });
      yield* studio.bind;
      expect(yield* Deferred.isDone(woken)).toBe(false);
      const address = yield* rest.address("api", "host");
      expect(yield* request(address.host, address.port, "/mcp")).toBe("backend:/api/mcp");
      yield* Deferred.await(woken).pipe(Effect.timeout("2 seconds"));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

/** Answers with its own name and what a gateway route forwarded to it. */
const echo =
  (name: string): RequestListener =>
  (incoming, response) => {
    response.end(
      JSON.stringify({
        backend: name,
        url: incoming.url,
        authorization: incoming.headers.authorization,
        profile: incoming.headers["content-profile"],
        prefix: incoming.headers["x-forwarded-prefix"],
      }),
    );
  };

it.live("serves legacy Kong's gateway routes while each service runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-gateway-routes-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const api = yield* backendWith(echo("api"));
      const admin = yield* backendWith(echo("admin"));
      const keys = {
        publishableKey: "sb_publishable_example",
        secretKey: "sb_secret_example",
        anonKey: "anon.jwt.value",
        serviceRoleKey: "service.role.jwt",
      };
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const register = (service: "rest" | "auth" | "pgmeta" | "analytics" | "pooler") =>
        network
          .register({
            id: service,
            endpoints: {
              http: {
                ...endpoint(api, Effect.succeed(true)),
                shared: sharedRoutes(
                  { service },
                  "http",
                  keys,
                  (name) => Effect.succeed(name === "admin" ? admin : api),
                  () => Effect.undefined,
                ),
                join: joinRoutes({ service }, "http"),
              },
            },
          })
          .pipe(Effect.tap((namespace) => namespace.bind));
      const rest = yield* register("rest");
      for (const service of ["auth", "pgmeta", "analytics"] as const) yield* register(service);
      const address = yield* rest.address("http", "host");
      const send = (path: string, headers: Readonly<Record<string, string>> = {}) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get(`http://${address.host}:${address.port}${path}`, {
            headers,
          });
          return response.status === 404 ? 404 : yield* response.json;
        }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
      const publishable = { apikey: keys.publishableKey };

      expect(yield* send("/graphql/v1", publishable)).toEqual({
        backend: "api",
        url: "/rpc/graphql",
        authorization: "Bearer anon.jwt.value",
        profile: "graphql_public",
        prefix: "/graphql/v1",
      });
      expect(yield* send("/graphql/v1", { ...publishable, "content-profile": "app" })).toEqual(
        expect.objectContaining({ profile: "app" }),
      );
      expect(yield* send("/rest-admin/v1/ready")).toEqual({
        backend: "admin",
        url: "/ready",
        prefix: "/rest-admin/v1/",
      });
      for (const path of [
        "/auth/v1/verify?token=t&type=magiclink",
        "/auth/v1/callback?code=c",
        "/auth/v1/authorize?provider=github",
      ])
        expect(yield* send(path, publishable)).toEqual({
          backend: "api",
          url: path.slice("/auth/v1".length),
          prefix: path.split("?", 1)[0],
        });
      expect(yield* send("/auth/v1/user", publishable)).toEqual(
        expect.objectContaining({ url: "/user", authorization: "Bearer anon.jwt.value" }),
      );
      expect(yield* send("/.well-known/oauth-authorization-server")).toEqual({
        backend: "api",
        url: "/.well-known/oauth-authorization-server",
        prefix: "/.well-known/oauth-authorization-server",
      });
      expect(yield* send("/pg/tables")).toEqual({ backend: "api", url: "/tables", prefix: "/pg/" });
      expect(yield* send("/analytics/v1/health")).toEqual(
        expect.objectContaining({ url: "/health", prefix: "/analytics/v1/" }),
      );
      expect(yield* send("/pooler/v2/tenants")).toBe(404);
      yield* register("pooler");
      expect(yield* send("/pooler/v2/tenants")).toEqual(
        expect.objectContaining({ url: "/v2/tenants", prefix: "/pooler/v2/" }),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps a dedicated listener's client X-Forwarded headers without Kong's gateway set", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-dedicated-headers-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const target = yield* backendWith((incoming, response) => {
        response.end(JSON.stringify(incoming.headers));
      });
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const studio = yield* network.register({
        id: "studio",
        endpoints: { http: endpoint(target, Effect.succeed(true)) },
      });
      yield* studio.bind;
      const address = yield* studio.address("http", "host");
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`http://${address.host}:${address.port}/`, {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "spoofed.example" },
      });
      const headers = yield* response.json;
      expect(headers).toEqual(
        expect.objectContaining({
          "x-forwarded-proto": "https",
          "x-forwarded-host": "spoofed.example",
          "x-forwarded-for": "127.0.0.1",
          "x-real-ip": "127.0.0.1",
        }),
      );
      for (const name of ["x-forwarded-port", "x-forwarded-path", "x-forwarded-prefix"])
        expect(headers).not.toHaveProperty(name);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("addresses docker runtime endpoints through the stack host alias", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-docker-alias-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const target = yield* backend;
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "docker", state });
      const namespace = yield* network.register({
        id: "one",
        endpoints: { api: endpoint(target, Effect.succeed(false)) },
      });
      yield* namespace.bind;
      const host = yield* namespace.address("api", "host");
      const runtime = yield* namespace.address("api", "runtime");
      expect(host.host).toBe("127.0.0.1");
      expect(runtime).toEqual({ ...host, host: DOCKER_HOST_ALIAS });
      yield* namespace.release;
      yield* namespace.releasePorts;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

/* Templates held inside `root`, the project directory the CLI passes. */
const authWith = (
  root: string,
  templates: ReadonlyArray<{ readonly id: string; readonly path: string }>,
  templateToken = "template-token",
): ServiceCreation => ({
  service: "auth",
  pin: selection.auth,
  config: { templates: templates.map((template) => ({ ...template, root })), templateToken },
});

/** An Auth shared route over a real project directory holding `invite.html`, beside `outside/`. */
const emailTemplates = (
  runtime: Network.NetworkRuntime,
  onAccess?: HttpAccessSink,
  apiTls?: NonNullable<StackNamespace.SavedStack["apiTls"]>,
  hostAddresses?: () => ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "network-email-" }),
    );
    const root = path.join(base, "project");
    const outside = path.join(base, "outside");
    yield* fs.makeDirectory(root);
    yield* fs.makeDirectory(outside);
    const invite = path.join(root, "invite.html");
    yield* fs.writeFileString(invite, "invite marker");
    const stackId = `email-${randomUUID()}`;
    const state = yield* makeTestState(path.join(base, "state"));
    yield* state.save({ ...stack(stackId), ...(apiTls === undefined ? {} : { apiTls }) });
    const backendCalls = { count: 0 };
    const target = yield* backendWith((_request, response) => {
      backendCalls.count += 1;
      response.end("backend");
    });
    const creation = yield* Ref.make(authWith(root, [{ id: "invite", path: invite }]));
    /* Auth's shared routes on `network`, bound. */
    const serve = (network: Network.Interface) =>
      Effect.gen(function* () {
        const namespace = yield* network.register({
          id: "auth",
          endpoints: {
            http: {
              ...endpoint(target, Effect.succeed(false)),
              shared: sharedRoutes(
                { service: "auth" },
                "http",
                { publishableKey: "", secretKey: "", anonKey: "", serviceRoleKey: "" },
                () => Effect.succeed(target),
                emailTemplateFile(Ref.get(creation)),
              ),
            },
          },
        });
        const [binding] = yield* namespace.bind;
        if (binding === undefined) return yield* new FixtureError({ message: "no binding" });
        yield* Effect.addFinalizer(() => network.releaseStack.pipe(Effect.ignore));
        return { namespace, port: binding.port };
      });
    const network = yield* makeTestNetwork({ stackId, runtime, state, onAccess, hostAddresses });
    const { namespace, port } = yield* serve(network);
    return {
      root,
      outside,
      invite,
      creation,
      backendCalls,
      port,
      namespace,
      network,
      state,
      stackId,
      /** A later owner's network over the same saved state, serving the same routes. */
      reopened: makeTestNetwork({ stackId, runtime, state, hostAddresses }).pipe(
        Effect.flatMap((next) =>
          serve(next).pipe(Effect.map((served) => ({ ...served, network: next }))),
        ),
      ),
    };
  });

/**
 * Sends a request head verbatim, Host included, over plain TCP from `localAddress` when given, or
 * TLS, and answers the raw reply.
 */
const rawHead = (
  port: number,
  lines: ReadonlyArray<string>,
  options: { readonly host?: string; readonly ca?: string; readonly localAddress?: string } = {},
) =>
  Effect.callback<string, FixtureError>((resume) => {
    const host = options.host ?? "127.0.0.1";
    const head = `${lines.join("\r\n")}\r\n\r\n`;
    const socket =
      options.ca === undefined
        ? Net.connect({ host, port, localAddress: options.localAddress }, () => socket.write(head))
        : Tls.connect({ host, port, ca: options.ca, servername: "localhost" }, () =>
            socket.write(head),
          );
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.once("error", (cause) =>
      resume(Effect.fail(new FixtureError({ message: cause.message }))),
    );
    socket.once("close", () => resume(Effect.succeed(received)));
    return Effect.sync(() => {
      socket.destroy();
    });
  });

/** Sends bytes as written, so a client never normalizes the path, and answers with the raw reply. */
const raw = (port: number, head: string, host = "127.0.0.1", connection = "close") =>
  rawHead(port, [head, "Host: stack", `Connection: ${connection}`], { host });

const invite = "/email/invite?token=template-token";

it.live("serves configured templates from the live creation and fresh from disk", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, invite: file, creation, backendCalls, port } = yield* emailTemplates("native");

      const first = yield* raw(port, `GET ${invite} HTTP/1.1`);
      expect(first).toMatch(/^HTTP\/1\.1 200 /u);
      expect(first.toLowerCase()).toContain("content-type: text/plain");
      expect(first.toLowerCase()).toContain("x-content-type-options: nosniff");
      expect(first).toContain("invite marker");

      const replacement = path.join(root, "invite.html.next");
      yield* fs.writeFileString(replacement, "replaced marker");
      yield* fs.rename(replacement, file);
      expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toContain("replaced marker");

      const notification = path.join(root, "changed.txt");
      yield* fs.writeFileString(notification, "notification marker");
      yield* Ref.set(
        creation,
        authWith(root, [{ id: "password_changed_notification", path: notification }], "next"),
      );
      expect(
        yield* raw(port, "GET /email/password_changed_notification?token=next HTTP/1.1"),
      ).toContain("notification marker");
      expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toMatch(/^HTTP\/1\.1 404 /u);
      expect(backendCalls.count).toBe(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("serves a template whose filename is not URL-safe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, creation, port } = yield* emailTemplates("native");
      for (const name of [
        "invite.html copy",
        "invite.日本語",
        "invite.v1#2",
        ...(process.platform === "win32" ? [] : ["invite.ht?ml"]),
      ]) {
        const file = path.join(root, name);
        yield* fs.writeFileString(file, `marker for ${name}`);
        yield* Ref.set(creation, authWith(root, [{ id: "invite", path: file }]));
        expect(yield* raw(port, `GET ${invite} HTTP/1.1`), name).toContain(`marker for ${name}`);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("answers only the exact configured template path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port, backendCalls } = yield* emailTemplates("native");
      for (const target of [
        "/email/other",
        "/email",
        "/email/",
        "/email/invite/",
        "/email/invite.html",
        "/email/invit%65",
        "/email/../../etc/passwd",
      ])
        expect(yield* raw(port, `GET ${target}?token=template-token HTTP/1.1`), target).toMatch(
          /^HTTP\/1\.1 404 /u,
        );
      expect(backendCalls.count).toBe(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refuses every template method but GET, and a WebSocket upgrade, without waking Auth", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port, backendCalls } = yield* emailTemplates("native");
      for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
        expect(yield* raw(port, `${method} ${invite} HTTP/1.1`), method).toMatch(
          /^HTTP\/1\.1 405 /u,
        );
      const upgrade = raw(
        port,
        `GET ${invite} HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`,
        "127.0.0.1",
        "Upgrade",
      ).pipe(Effect.orElseSucceed(() => ""));
      expect(yield* upgrade).toBe("");
      expect(backendCalls.count).toBe(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "serves an in-root symlink at a template path, and its retargeted file on the next fetch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, invite: file, port } = yield* emailTemplates("native");
        const shared = path.join(root, "shared");
        yield* fs.makeDirectory(shared);
        yield* fs.writeFileString(path.join(shared, "a.html"), "first shared marker");
        yield* fs.writeFileString(path.join(shared, "b.html"), "second shared marker");
        yield* fs.remove(file);
        yield* fs.symlink(path.join("shared", "a.html"), file);
        const linked = yield* raw(port, `GET ${invite} HTTP/1.1`);
        expect(linked).toMatch(/^HTTP\/1\.1 200 /u);
        expect(linked).toContain("first shared marker");
        yield* fs.remove(file);
        yield* fs.symlink(path.join(shared, "b.html"), file);
        expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toContain("second shared marker");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("never serves a link or directory escaping the root, or a FIFO, at a template path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { root, outside, invite: file, creation, port } = yield* emailTemplates("native");
      const escapee = path.join(outside, "outside.html");
      yield* fs.writeFileString(escapee, "outside marker");

      const folder = path.join(root, "templates");
      yield* fs.makeDirectory(folder);
      yield* fs.writeFileString(path.join(folder, "nested.html"), "nested marker");
      yield* fs.writeFileString(path.join(outside, "nested.html"), "outside marker");
      yield* Ref.set(
        creation,
        authWith(root, [{ id: "invite", path: path.join(folder, "nested.html") }]),
      );
      expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toContain("nested marker");
      yield* fs.rename(folder, `${folder}.aside`);
      yield* fs.symlink(outside, folder);
      const throughParent = yield* raw(port, `GET ${invite} HTTP/1.1`);
      expect(throughParent).toMatch(/^HTTP\/1\.1 404 /u);
      expect(throughParent).not.toContain("outside marker");
      yield* Ref.set(creation, authWith(root, [{ id: "invite", path: file }]));

      yield* fs.remove(file);
      yield* fs.symlink(escapee, file);
      const escaped = yield* raw(port, `GET ${invite} HTTP/1.1`);
      expect(escaped).toMatch(/^HTTP\/1\.1 404 /u);
      expect(escaped).not.toContain("outside marker");

      yield* fs.remove(file);
      yield* fs.makeDirectory(file);
      expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toMatch(/^HTTP\/1\.1 404 /u);

      if (process.platform === "win32") return;
      yield* fs.remove(file, { recursive: true });
      expect(yield* spawner.exitCode(ChildProcess.make("mkfifo", [file]))).toBe(0);
      expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toMatch(/^HTTP\/1\.1 404 /u);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

/* The open-and-verify step on POSIX; Windows checks its handle through `bun:ffi` instead. */
it.live.skipIf(process.platform === "win32")(
  "refuses a resolved template path whose final file was swapped for a link",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const resolved = path.join(base, "invite.html");
        yield* fs.writeFileString(resolved, "resolved marker");
        expect(new TextDecoder().decode(yield* readResolvedFile(resolved, false))).toBe(
          "resolved marker",
        );
        yield* fs.writeFileString(path.join(base, "other.html"), "other marker");
        yield* fs.remove(resolved);
        yield* fs.symlink(path.join(base, "other.html"), resolved);
        const error = yield* Effect.flip(readResolvedFile(resolved, false));
        expect(error.cause).toMatchObject({ code: "ELOOP" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "refuses a resolved template path whose parent directory was swapped for a link outside",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const folder = path.join(base, "templates");
        const outside = path.join(base, "outside");
        yield* fs.makeDirectory(folder);
        yield* fs.makeDirectory(outside);
        const resolved = path.join(folder, "invite.html");
        yield* fs.writeFileString(resolved, "resolved marker");
        yield* fs.writeFileString(path.join(outside, "invite.html"), "outside marker");
        yield* fs.rename(folder, `${folder}.aside`);
        yield* fs.symlink(outside, folder);
        const error = yield* Effect.flip(readResolvedFile(resolved, false));
        expect(error.message).toContain("Not a regular file at this path");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("sends no CORS header on any template response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port } = yield* emailTemplates("native");
      const origin = "Origin: https://example.test";
      for (const head of [
        `GET ${invite} HTTP/1.1\r\n${origin}`,
        `GET /email/other HTTP/1.1\r\n${origin}`,
        `OPTIONS ${invite} HTTP/1.1\r\n${origin}\r\nAccess-Control-Request-Method: GET`,
      ])
        expect((yield* raw(port, head)).toLowerCase()).not.toContain("access-control-allow");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const external = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;

/* A LAN test that cannot reach the external interface fails rather than skips. */
const externalAddress =
  external === undefined
    ? Effect.die("no external IPv4 address to reach the API from the LAN side")
    : Effect.succeed(external);

it.live("keeps a template behind its token on the external address, and off it on native", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* externalAddress;
      for (const runtime of ["docker", "podman"] as const) {
        const { port } = yield* emailTemplates(runtime);
        for (const target of ["/email/invite", "/email/invite?token=wrong"])
          expect(yield* raw(port, `GET ${target} HTTP/1.1`, host), target).toMatch(
            /^HTTP\/1\.1 404 /u,
          );
        const served = yield* raw(port, `GET ${invite} HTTP/1.1`, host);
        expect(served).toMatch(/^HTTP\/1\.1 200 /u);
        expect(served).toContain("invite marker");
      }
      const { port } = yield* emailTemplates("native");
      expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toMatch(/^HTTP\/1\.1 200 /u);
      yield* Effect.flip(raw(port, `GET ${invite} HTTP/1.1`, host));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("records a template request with its token redacted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const access = yield* Deferred.make<HttpAccess>();
      const { port } = yield* emailTemplates("native", (record) =>
        Deferred.succeed(access, record).pipe(Effect.asVoid),
      );
      yield* raw(port, `GET ${invite} HTTP/1.1`);
      expect((yield* Deferred.await(access)).target).toBe("/email/invite?token=redacted");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

/**
 * A pinned port below the stack's native and auto port ranges and every OS ephemeral range, so
 * neither another test's auto allocation nor an outbound socket can already hold it. It stays
 * under 9000, where other files pin fixed ports, and is redrawn until the bind's own vacancy guard
 * would accept it.
 */
const pinnedPort: Effect.Effect<number> = Effect.gen(function* () {
  const port = 1024 + (Math.abs(Hash.string(randomUUID())) % (9_000 - 1024));
  const vacant = Ports.probeVacant(process.platform)("pinned", "127.0.0.1", port).pipe(
    Effect.as(true),
    Effect.catchTag("PortError", () => Effect.succeed(false)),
  );
  return !(yield* Ports.accepts("127.0.0.1", port)) && (yield* vacant) ? port : yield* pinnedPort;
});

it.live("addresses a pinned endpoint from its configured port without a registry row", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-pinned-address-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const target = yield* backend;
      const port = yield* pinnedPort;
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const namespace = yield* network.register({
        id: "db",
        endpoints: { sql: { ...endpoint(target, Effect.succeed(false)), port } },
      });

      expect((yield* namespace.address("sql", "host")).port).toBe(port);
      expect((yield* namespace.address("sql", "runtime")).port).toBe(port);
      expect(yield* reservedPort(root, "stack", "db:sql")).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a pinned port is reserved only while its listener is open", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-pinned-stop-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("first"));
      yield* state.save(stack("second"));
      const target = yield* backend;
      const port = yield* pinnedPort;
      const firstEnabled = yield* Ref.make(true);
      const firstNetwork = yield* makeTestNetwork({ stackId: "first", runtime: "native", state });
      const first = yield* firstNetwork.register({
        id: "db",
        endpoints: { sql: { ...endpoint(target, Ref.get(firstEnabled)), port } },
      });
      yield* first.bind;
      expect(yield* reservedPort(root, "first", "db:sql")).toBe(port);

      yield* Ref.set(firstEnabled, false);
      yield* first.close;
      expect(yield* reservedPort(root, "first", "db:sql")).toBeUndefined();

      const secondNetwork = yield* makeTestNetwork({ stackId: "second", runtime: "native", state });
      const second = yield* secondNetwork.register({
        id: "db",
        endpoints: { sql: { ...endpoint(target, Effect.succeed(true)), port } },
      });
      yield* second.bind;
      expect((yield* second.address("sql", "host")).port).toBe(port);
      expect(yield* request("127.0.0.1", port, "/started")).toBe("backend:/started");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a pinned shared listener keeps its reservation until its last route closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-pinned-shared-" });
      const state = yield* makeTestState(root);
      yield* state.save(stack("stack"));
      const target = yield* backend;
      const port = yield* pinnedPort;
      const firstEnabled = yield* Ref.make(true);
      const secondEnabled = yield* Ref.make(true);
      const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
      const first = yield* network.register({
        id: "rest",
        endpoints: {
          api: { ...endpoint(target, Ref.get(firstEnabled)), port, shared: [{ prefix: "/rest" }] },
        },
      });
      const second = yield* network.register({
        id: "auth",
        endpoints: {
          api: { ...endpoint(target, Ref.get(secondEnabled)), port, shared: [{ prefix: "/auth" }] },
        },
      });
      yield* first.bind;
      yield* second.bind;
      expect(yield* reservedPort(root, "stack", "api")).toBe(port);
      expect(yield* request("127.0.0.1", port, "/auth/v1")).toBe("backend:/auth/v1");

      yield* Ref.set(firstEnabled, false);
      yield* first.close;
      expect(yield* reservedPort(root, "stack", "api")).toBe(port);
      expect(yield* request("127.0.0.1", port, "/auth/v1")).toBe("backend:/auth/v1");

      yield* Ref.set(secondEnabled, false);
      yield* second.close;
      expect(yield* reservedPort(root, "stack", "api")).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "sends writes to a fresh-writes endpoint's dedicated and joined routes over fresh connections",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "network-fresh-writes-" });
        const state = yield* makeTestState(root);
        yield* state.save(stack("stack"));
        const target = yield* backend;
        let connections = 0;
        target.server.on("connection", () => {
          connections += 1;
        });
        const network = yield* makeTestNetwork({ stackId: "stack", runtime: "native", state });
        const rest = yield* network.register(claimant("rest", target, Effect.succeed(true)));
        yield* rest.bind;
        const studio = yield* network.register({
          id: "studio",
          endpoints: {
            http: {
              ...joinEndpoint(target, Effect.succeed(true)),
              freshWrites: freshWrites({ service: "studio" }, "http"),
            },
          },
        });
        yield* studio.bind;
        const api = yield* rest.address("api", "host");
        const dedicated = yield* studio.address("http", "host");
        const post = (port: number, path: string) =>
          Effect.gen(function* () {
            const client = yield* HttpClient.HttpClient;
            const response = yield* client.post(`http://127.0.0.1:${port}${path}`, {
              body: HttpBody.text("{}"),
            });
            return yield* response.text;
          }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
        for (const _ of [1, 2]) expect(yield* post(api.port, "/rest")).toBe("backend:/rest");
        expect(connections).toBe(1);
        for (const _ of [1, 2]) expect(yield* post(api.port, "/mcp")).toBe("backend:/api/mcp");
        for (const _ of [1, 2]) expect(yield* post(dedicated.port, "/x")).toBe("backend:/x");
        expect(connections).toBe(5);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("serves a template only for its exact token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port } = yield* emailTemplates("native");
      for (const token of [
        "template-tokex",
        "template-toke",
        "template-tokenn",
        "",
        "TEMPLATE-TOKEN",
      ])
        expect(yield* raw(port, `GET /email/invite?token=${token} HTTP/1.1`), token).toMatch(
          /^HTTP\/1\.1 404 /u,
        );
      expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toMatch(/^HTTP\/1\.1 200 /u);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("warns once about a template that keeps failing, and again after it recovers", () => {
  const warnings: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { invite: file, port } = yield* emailTemplates("native");
      const served = () => warnings.filter((line) => line.includes("was not served")).length;
      yield* fs.remove(file);
      for (const _ of [1, 2, 3])
        expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toMatch(/^HTTP\/1\.1 404 /u);
      expect(served()).toBe(1);
      yield* fs.writeFileString(file, "invite marker");
      expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toMatch(/^HTTP\/1\.1 200 /u);
      yield* fs.remove(file);
      expect(yield* raw(port, `GET ${invite} HTTP/1.1`)).toMatch(/^HTTP\/1\.1 404 /u);
      expect(served()).toBe(2);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, captureLogs(["Warn"])(warnings))));
});

/* A self-signed pair for localhost and 127.0.0.1, standing in for `[api.tls]`'s local one. */
const localTls = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const certs = path.join(import.meta.dirname, "..", "tests", "certs");
  return {
    cert: yield* fs.readFileString(path.join(certs, "trusted.crt")),
    key: yield* fs.readFileString(path.join(certs, "localhost.key")),
  };
});

const savedTls = (tls: { readonly cert: string; readonly key: string }) => ({
  ...tls,
  networks: [],
  selfCheck: "self-check-token",
});

for (const runtime of ["docker", "native"] as const)
  it.live(`serves the ${runtime} API over TLS and runtimes plain HTTP on the same port`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tls = yield* localTls;
        const { port, namespace } = yield* emailTemplates(runtime, undefined, savedTls(tls));
        const host = yield* namespace.address("http", "host");
        const inside = yield* namespace.address("http", "runtime");
        expect(host).toMatchObject({ host: "127.0.0.1", port, scheme: "https" });
        expect(inside).toMatchObject({
          host: runtime === "native" ? "127.0.0.1" : DOCKER_HOST_ALIAS,
          port,
        });
        expect(inside.scheme).toBeUndefined();

        const get = (path: string, ...lines: Array<string>) => [
          `GET ${path} HTTP/1.1`,
          ...lines,
          "Connection: close",
        ];
        const at = `Host: host.supabase.internal:${port}`;
        const secure = yield* rawHead(port, get("/auth/v1/health", `Host: localhost:${port}`), {
          ca: tls.cert,
        });
        expect(secure).toMatch(/^HTTP\/1\.1 200 /u);
        expect(secure).toContain("backend");
        expect(
          yield* rawHead(port, get(invite, `Host: localhost:${port}`), { ca: tls.cert }),
        ).toMatch(/^HTTP\/1\.1 404 /u);

        expect(yield* rawHead(port, get("/auth/v1/health", at))).toMatch(/^HTTP\/1\.1 200 /u);
        expect(yield* rawHead(port, get(invite, at))).toContain("invite marker");
        /* A function forwarding a browser's headers to the runtime URL keeps working. */
        expect(
          yield* rawHead(
            port,
            get(
              "/auth/v1/health",
              at,
              "Origin: http://localhost:3000",
              "Sec-Fetch-Site: cross-site",
            ),
          ),
        ).toMatch(/^HTTP\/1\.1 200 /u);
        for (const head of [`Host: evil.example:${port}`, "Host: 127.0.0.1"])
          expect(yield* rawHead(port, get("/auth/v1/health", head)), head).toMatch(
            /^HTTP\/1\.1 421 /u,
          );
        /* The external address is this host's own, so a host client there stays admitted. */
        const lan = yield* externalAddress;
        if (runtime === "docker")
          expect(yield* rawHead(port, get("/auth/v1/health", at), { host: lan })).toMatch(
            /^HTTP\/1\.1 200 /u,
          );
        else yield* Effect.flip(rawHead(port, get("/auth/v1/health", at), { host: lan }));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

it.live("keeps every listener, URL and scheme of the API without TLS", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { port, namespace } = yield* emailTemplates("docker");
      expect(yield* namespace.address("http", "host")).toEqual({
        name: "http",
        protocol: "http",
        host: "127.0.0.1",
        port,
      });
      expect(
        yield* rawHead(port, [
          "GET /auth/v1/health HTTP/1.1",
          "Host: anything",
          "Connection: close",
        ]),
      ).toMatch(/^HTTP\/1\.1 200 /u);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

/* This host holds only a fake gateway, so its LAN address connecting to loopback stands in for a
   container's self-check arriving at a `host-gateway` set to another address of this host. */
const gatewayOnly = () => new Set(["192.0.2.1"]);

/** The LAN address, its /24 network with the held fake gateway, and a sibling address in it. */
const lanNetwork = Effect.gen(function* () {
  const lan = yield* externalAddress;
  const [a, b, c, d] = lan.split(".").map(Number);
  return {
    lan,
    network: { subnet: `${a}.${b}.${c}.0/24`, gateway: "192.0.2.1" },
    sibling: `${a}.${b}.${c}.${d === 254 ? 253 : (d ?? 0) + 1}`,
  };
});

/* A plain API request from `from`, to `to`; a refused peer reads as "". */
const plainFrom = (port: number, from: string, to = "127.0.0.1") =>
  rawHead(
    port,
    ["GET /auth/v1/health HTTP/1.1", `Host: host.supabase.internal:${port}`, "Connection: close"],
    { host: to, localAddress: from },
  ).pipe(Effect.orElseSucceed(() => ""));

const selfCheckFrom = (port: number, from: string) =>
  rawHead(
    port,
    [
      "GET /__api_tls_self_check?token=self-check-token HTTP/1.0",
      `Host: host.supabase.internal:${port}`,
    ],
    { localAddress: from },
  );

it.live("admits a saved arrival's network at its address once that network is adopted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tls = yield* localTls;
      const { lan, network: lanNet, sibling } = yield* lanNetwork;
      const { port, network } = yield* emailTemplates(
        "docker",
        undefined,
        { ...savedTls(tls), learnedArrivals: [{ peer: sibling, local: "127.0.0.1" }] },
        gatewayOnly,
      );
      expect(yield* plainFrom(port, lan)).toBe("");
      yield* network.adoptApiNetworks("self-check-token", [lanNet]);
      expect(yield* plainFrom(port, lan)).toMatch(/^HTTP\/1\.1 200 /u);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("admits a learned self-check only at the exact address it arrived on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tls = yield* localTls;
      const { lan, network: lanNet } = yield* lanNetwork;
      const { port, network } = yield* emailTemplates(
        "docker",
        undefined,
        savedTls(tls),
        gatewayOnly,
      );
      expect(yield* plainFrom(port, lan)).toBe("");
      expect(yield* selfCheckFrom(port, lan)).toMatch(/^HTTP\/1\./u);
      expect(yield* network.learnedApi("self-check-token")).toEqual([
        { peer: lan, local: "127.0.0.1" },
      ]);
      expect(yield* plainFrom(port, lan)).toMatch(/^HTTP\/1\.1 200 /u);
      expect(yield* plainFrom(port, lan, lan)).toBe("");
      /* The arrival's own network adds its address, never another one. */
      yield* network.adoptApiNetworks("self-check-token", [lanNet]);
      expect(yield* plainFrom(port, lan)).toMatch(/^HTTP\/1\.1 200 /u);
      expect(yield* plainFrom(port, lan, lan)).toBe("");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("admits saved arrivals on a later owner's listener until a start sets TLS again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tls = yield* localTls;
      const { lan, network: lanNet } = yield* lanNetwork;
      const first = yield* emailTemplates("docker", undefined, savedTls(tls), gatewayOnly);
      expect(yield* selfCheckFrom(first.port, lan)).toMatch(/^HTTP\/1\./u);
      /* What the start check saves for later owners. */
      yield* first.state.save({
        ...stack(first.stackId),
        apiTls: {
          ...savedTls(tls),
          networks: [lanNet],
          learnedArrivals: yield* first.network.learnedApi("self-check-token"),
        },
      });
      yield* first.namespace.close;
      const later = yield* first.reopened;
      expect(yield* plainFrom(later.port, lan)).toMatch(/^HTTP\/1\.1 200 /u);
      yield* later.namespace.close;
      yield* first.state.save({
        ...stack(first.stackId),
        apiTls: { ...savedTls(tls), networks: [lanNet], selfCheck: "next-start" },
      });
      const [binding] = yield* later.namespace.bind;
      expect(yield* plainFrom(binding?.port ?? later.port, lan)).toBe("");
      expect(yield* later.network.learnedApi("next-start")).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("advertises the scheme the open API listener serves, not the saved TLS", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tls = yield* localTls;
      const { namespace, state, stackId } = yield* emailTemplates(
        "docker",
        undefined,
        savedTls(tls),
      );
      expect(yield* namespace.address("http", "host")).toMatchObject({ scheme: "https" });
      yield* state.save(stack(stackId));
      expect(yield* namespace.address("http", "host")).toMatchObject({ scheme: "https" });
      expect((yield* namespace.bindings).find(({ name }) => name === "http")?.scheme).toBe("https");
      yield* namespace.close;
      expect((yield* namespace.address("http", "host")).scheme).toBeUndefined();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "refuses plain HTTP from a peer outside the rule and serves it over TLS on the same port",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tls = yield* localTls;
        const lan = yield* externalAddress;
        /* The real rule, with this host's addresses left out so its LAN address stands in for a
         routed peer connecting to it. */
        const listener = (networks: ReadonlyArray<ApiTlsNetwork>) =>
          makeHttpProxy({
            host: "0.0.0.0",
            port: 0,
            tls: { ...tls, plainPeer: plainPeerAllowed(networks, () => new Set()) },
          }).pipe(Effect.map(({ port }) => port));
        const get = (port: number) => [
          "GET / HTTP/1.1",
          `Host: host.supabase.internal:${port}`,
          "Connection: close",
        ];
        const plain = (port: number, host: string) =>
          rawHead(port, get(port), { host }).pipe(Effect.orElseSucceed(() => ""));

        const outside = yield* listener([]);
        expect(yield* plain(outside, lan)).toBe("");
        expect(yield* rawHead(outside, get(outside), { host: lan, ca: tls.cert })).toMatch(
          /^HTTP\/1\.1 404 /u,
        );
        expect(yield* plain(outside, "127.0.0.1")).toMatch(/^HTTP\/1\.1 404 /u);

        const subnet = `${lan}/32`;
        expect(yield* plain(yield* listener([{ subnet, gateway: lan }]), lan)).toMatch(
          /^HTTP\/1\.1 404 /u,
        );
        expect(yield* plain(yield* listener([{ subnet, gateway: "127.0.0.1" }]), lan)).toBe("");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "reads the saved TLS before a shared API bind owns any scope, so it stays interruptible",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "network-tls-read-" });
        const state = yield* makeTestState(path.join(base, "state"));
        const stackId = `tls-read-${randomUUID()}`;
        yield* state.save(stack(stackId));
        const reading = yield* Deferred.make<void>();
        let stalled = false;
        const network = yield* makeTestNetwork({
          stackId,
          runtime: "docker",
          state: {
            ...state,
            read: (id) =>
              Effect.suspend(() =>
                stalled
                  ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))
                  : state.read(id),
              ),
          },
        });
        yield* Effect.addFinalizer(() => network.releaseStack.pipe(Effect.ignore));
        const target = yield* backendWith((_request, response) => response.end("backend"));
        const namespace = yield* network.register({
          id: "rest",
          endpoints: {
            http: { ...endpoint(target, Effect.succeed(false)), shared: [{ prefix: "/rest/v1" }] },
          },
        });
        stalled = true;
        const binding = yield* Effect.forkChild(namespace.bind);
        yield* Deferred.await(reading);
        yield* Fiber.interrupt(binding);
        stalled = false;
        expect(yield* namespace.bind).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
