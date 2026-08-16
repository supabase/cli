import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { HttpServer } from "effect/unstable/http";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { describe, expect } from "vitest";
import { DaemonServer } from "./DaemonServer.ts";
import { acquireControl, controlEndpoint, controlEndpointPath } from "./managed/control.ts";
import { controlTransportLayer, unixHttpClientLayer } from "./platform-node.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { Stack } from "./Stack.ts";

const STACK_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const RUNTIME_ROOT = "/tmp/supabase-control-test";

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(controlTransportLayer));

const makeStack = (started: { value: boolean }): Stack["Service"] => ({
  getInfo: () =>
    Effect.succeed({
      url: "http://127.0.0.1",
      dbUrl: "postgres://127.0.0.1",
      publishableKey: "publishable",
      secretKey: "secret",
      anonJwt: "anon",
      serviceRoleJwt: "service",
      serviceEndpoints: {},
    }),
  start: () => Effect.sync(() => void (started.value = true)),
  stop: () => Effect.void,
  dispose: () => Effect.void,
  startService: () => Effect.void,
  stopService: () => Effect.void,
  restartService: () => Effect.void,
  reloadFunctions: () => Effect.void,
  reloadEdgeRuntime: () => Effect.void,
  getState: () => Effect.die("unused"),
  getAllStates: () => Effect.succeed([]),
  stateChanges: () => Effect.succeed(Stream.empty),
  allStateChanges: () => Stream.empty,
  waitReady: () => Effect.void,
  waitAllReady: () => Effect.void,
  subscribeLogs: () => Stream.empty,
  subscribeAllLogs: () => Stream.empty,
  logHistory: () => Effect.succeed([]),
  logHistoryAll: () => Effect.succeed([]),
});

const listenRawResponse = (port: number, body: string): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(body);
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

const listenRaw = (port: number): Promise<Server> => listenRawResponse(port, "not-supabase");

const closeRaw = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const spawnBoundChild = (port: number) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'const http=require("node:http"); const server=http.createServer((_req,res)=>res.end("child")); server.listen(Number(process.argv[1]), "127.0.0.1", () => process.send?.("ready"));',
      String(port),
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`child exited before ready: ${code}`)));
    child.on("message", (message) => {
      if (message === "ready") resolve();
    });
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return { child, ready, exited };
};

describe("managed control endpoint", () => {
  it.live("derives one deterministic loopback endpoint from the ownership id", () => {
    return Effect.sync(() => {
      const path = controlEndpointPath(RUNTIME_ROOT, STACK_ID);
      expect(path).toBe("http://127.0.0.1:59273");
    });
  });

  it.live("serves DaemonServer and RemoteStack on the owned listener", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const owner = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
          if (owner._tag !== "Owned") throw new Error("expected control ownership");
          const started = { value: false };
          const stackLayer = Layer.succeed(Stack, makeStack(started));
          const daemonRuntime = ManagedRuntime.make(
            DaemonServer.layerWithShutdown(Effect.void, owner.ownerStatus).pipe(
              Layer.provide(stackLayer),
              Layer.provide(Layer.succeed(HttpServer.HttpServer, owner.server)),
            ),
          );
          yield* Effect.promise(() => daemonRuntime.runPromise(DaemonServer));
          const remoteRuntime = ManagedRuntime.make(
            RemoteStack.layer(owner.endpoint).pipe(Layer.provide(unixHttpClientLayer)),
          );
          yield* Effect.promise(() =>
            remoteRuntime.runPromise(Effect.flatMap(Stack, (stack) => stack.start())),
          );
          expect(started.value).toBe(true);
          expect(
            yield* Effect.promise(() =>
              remoteRuntime.runPromise(Effect.flatMap(Stack, (stack) => stack.getInfo())),
            ),
          ).toMatchObject({ publishableKey: "publishable" });
          yield* Effect.promise(() => remoteRuntime.dispose());
          yield* Effect.promise(() => daemonRuntime.dispose());
        }),
      ),
    ),
  );

  it.live("attaches a concurrent caller to the live owner", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const owner = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
          if (owner._tag !== "Owned") throw new Error("expected control ownership");
          const daemonRuntime = ManagedRuntime.make(
            DaemonServer.layerWithShutdown(Effect.void, owner.ownerStatus).pipe(
              Layer.provide(Layer.succeed(Stack, makeStack({ value: false }))),
              Layer.provide(Layer.succeed(HttpServer.HttpServer, owner.server)),
            ),
          );
          yield* Effect.promise(() => daemonRuntime.runPromise(DaemonServer));
          const contender = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
          expect(contender._tag).toBe("Attached");
          expect(yield* contender.ownerStatus).toMatchObject({
            protocolVersion: 1,
            state: "starting",
          });
          yield* owner.setState("running");
          expect(yield* contender.ownerStatus).toMatchObject({
            protocolVersion: 1,
            state: "running",
            ready: true,
          });
          yield* Effect.promise(() => daemonRuntime.dispose());
        }),
      ),
    ),
  );

  it.live("binds again after the owner scope releases the address", () =>
    live(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
            expect(owner._tag).toBe("Owned");
          }),
        );
        const next = yield* Effect.scoped(
          Effect.gen(function* () {
            return yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
          }),
        );
        expect(next._tag).toBe("Owned");
      }),
    ),
  );

  it.live("rejects an unrelated listener without taking it over", () =>
    live(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* controlEndpoint(STACK_ID);
          const unrelated = yield* Effect.acquireRelease(
            Effect.promise(() => listenRaw(endpoint.port)),
            (server) => Effect.promise(() => closeRaw(server)),
          );
          const result = yield* acquireControl({
            runtimeRoot: RUNTIME_ROOT,
            stackId: STACK_ID,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Left" as const, error }),
              onSuccess: (value) => ({ _tag: "Right" as const, value }),
            }),
          );
          expect(result._tag).toBe("Left");
          if (result._tag === "Left") expect(result.error._tag).toBe("ControlAddressConflictError");
          expect(unrelated.listening).toBe(true);
        }),
      ),
    ),
  );

  it.live("preserves an explicit owner protocol mismatch", () =>
    live(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* controlEndpoint(STACK_ID);
          const unrelated = yield* Effect.acquireRelease(
            Effect.promise(() =>
              listenRawResponse(
                endpoint.port,
                JSON.stringify({ protocolVersion: 2, state: "running", ready: true }),
              ),
            ),
            (server) => Effect.promise(() => closeRaw(server)),
          );
          const result = yield* acquireControl({
            runtimeRoot: RUNTIME_ROOT,
            stackId: STACK_ID,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Left" as const, error }),
              onSuccess: (value) => ({ _tag: "Right" as const, value }),
            }),
          );
          expect(result._tag).toBe("Left");
          if (result._tag === "Left")
            expect(result.error._tag).toBe("ControlProtocolMismatchError");
          expect(unrelated.listening).toBe(true);
        }),
      ),
    ),
  );

  it.live("rebinds after a concurrent graceful close", () =>
    live(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
          if (owner._tag !== "Owned") throw new Error("expected control ownership");
          const contender = yield* acquireControl({
            runtimeRoot: RUNTIME_ROOT,
            stackId: STACK_ID,
          }).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.sleep("1 millis");
          yield* owner.close;
          const next = yield* Fiber.join(contender);
          expect(next._tag).toBe("Owned");
          if (next._tag === "Owned") expect(next.acquiredAfterClose).toBe(true);
        }),
      ),
    ),
  );

  it.live("reclaims the endpoint after the owning process dies", () =>
    live(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* controlEndpoint(STACK_ID);
          const child = spawnBoundChild(endpoint.port);
          yield* Effect.promise(() => child.ready);
          child.child.kill("SIGKILL");
          yield* Effect.promise(() => child.exited);
          const owner = yield* acquireControl({ runtimeRoot: RUNTIME_ROOT, stackId: STACK_ID });
          expect(owner._tag).toBe("Owned");
        }),
      ),
    ),
  );
});
