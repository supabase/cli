import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Data, Deferred, Effect, FileSystem, Layer, Path, Ref } from "effect";
import * as Net from "node:net"; // oxlint-disable-line effecttsgo/node-builtin-import -- fixture retains an idle HTTP connection.
import { createServer } from "node:http"; // oxlint-disable-line effecttsgo/node-builtin-import -- real socket fixture.
import { HttpClient } from "effect/unstable/http";
import * as Network from "./Network.ts";
import * as State from "./State.ts";

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
