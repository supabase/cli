import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Data, Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref } from "effect";
import * as Net from "node:net"; // oxlint-disable-line effecttsgo/node-builtin-import -- fixture retains an idle HTTP connection.
import { createServer } from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- real socket fixture.
import { HttpClient } from "effect/unstable/http";
import * as Network from "./Network.ts";
import * as PortReservations from "./namespace/PortReservations.ts";
import { DOCKER_HOST_ALIAS } from "./runtime/Container.ts";
import * as StackNamespace from "./StackNamespace.ts";

const makeTestState = (root: string) =>
  Layer.build(StackNamespace.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, StackNamespace.Service)),
  );
const makeTestNetwork = (options: {
  readonly stackId: string;
  readonly runtime: Network.NetworkRuntime;
  readonly state: StackNamespace.Interface;
}) =>
  Layer.build(
    Network.layer({ stackId: options.stackId, runtime: options.runtime }).pipe(
      Layer.provide(Layer.succeed(StackNamespace.Service, options.state)),
    ),
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
