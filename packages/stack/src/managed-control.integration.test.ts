import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Stream } from "effect";
import { HttpServer } from "effect/unstable/http";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { describe, expect } from "vitest";
import { DaemonServer } from "./DaemonServer.ts";
import {
  acquireControl,
  controlEndpoint,
  ControlBindError,
  ControlTransport,
  ControlTransportError,
} from "./managed/control.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { httpTransportClientLayer } from "./HttpTransportClient.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { Stack } from "./Stack.ts";

const STACK_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const COLLIDING_STACK_ID = `${STACK_ID.slice(0, 10)}${"f".repeat(54)}`;

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
      const endpoint = Effect.runSync(controlEndpoint(STACK_ID));
      expect(endpoint.url).toBe("http://127.0.0.1:13737");
    });
  });

  it.live("serves DaemonServer and RemoteStack on the owned listener", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const owner = yield* acquireControl({ stackId: STACK_ID });
          if (owner._tag !== "Owned") throw new Error("expected control ownership");
          const started = { value: false };
          const stackLayer = Layer.succeed(Stack, makeStack(started));
          const daemonRuntime = ManagedRuntime.make(
            DaemonServer.layerWithShutdown(Effect.void, owner.ownerStatus, {
              includeOwnerRoute: false,
            }).pipe(
              Layer.provide(stackLayer),
              Layer.provide(Layer.succeed(HttpServer.HttpServer, owner.server)),
            ),
          );
          yield* Effect.promise(() => daemonRuntime.runPromise(DaemonServer));
          const remoteRuntime = ManagedRuntime.make(
            RemoteStack.layer(owner.endpoint).pipe(Layer.provide(httpTransportClientLayer)),
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

  it.live("publishes owner status before and after DaemonServer uses the same listener", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const owner = yield* acquireControl({ stackId: STACK_ID });
          if (owner._tag !== "Owned") throw new Error("expected control ownership");
          const before = yield* Effect.promise(() => fetch(`${owner.endpoint.url}/owner`));
          expect(before.status).toBe(200);
          expect(yield* Effect.promise(() => before.json())).toMatchObject({ state: "starting" });
          const beforeRoutes = yield* Effect.promise(() =>
            fetch(`${owner.endpoint.url}/status`, { signal: AbortSignal.timeout(500) }),
          );
          expect(beforeRoutes.status).toBe(503);
          const daemonRuntime = ManagedRuntime.make(
            DaemonServer.layerWithShutdown(Effect.void, owner.ownerStatus, {
              includeOwnerRoute: false,
            }).pipe(
              Layer.provide(Layer.succeed(Stack, makeStack({ value: false }))),
              Layer.provide(Layer.succeed(HttpServer.HttpServer, owner.server)),
            ),
          );
          yield* Effect.promise(() => daemonRuntime.runPromise(DaemonServer));
          const status = yield* Effect.promise(() => fetch(`${owner.endpoint.url}/status`));
          expect(status.status).toBe(200);
          yield* owner.setState("running");
          const after = yield* Effect.promise(() => fetch(`${owner.endpoint.url}/owner`));
          expect(yield* Effect.promise(() => after.json())).toMatchObject({
            state: "running",
            ready: true,
          });
          yield* Effect.promise(() => daemonRuntime.dispose());
        }),
      ),
    ),
  );

  it.live("hands ready-owner stop requests to DaemonServer exactly once", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const owner = yield* acquireControl({ stackId: STACK_ID });
          if (owner._tag !== "Owned") throw new Error("expected control ownership");
          const stopCalls = { value: 0 };
          const stack = {
            ...makeStack({ value: false }),
            stop: () =>
              Effect.sync(() => {
                stopCalls.value += 1;
              }),
          } satisfies Stack["Service"];
          const daemonRuntime = ManagedRuntime.make(
            DaemonServer.layerWithShutdown(
              owner.setState("stopping", false),
              owner.ownerStatus,
            ).pipe(
              Layer.provide(Layer.succeed(Stack, stack)),
              Layer.provide(Layer.succeed(HttpServer.HttpServer, owner.server)),
            ),
          );
          yield* Effect.promise(() => daemonRuntime.runPromise(DaemonServer));
          yield* owner.setState("running");

          const response = yield* Effect.promise(() =>
            fetch(`${owner.endpoint.url}/stop`, { method: "POST" }),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toEqual({ ok: true });
          expect(stopCalls.value).toBe(1);

          yield* Effect.promise(() => daemonRuntime.dispose());
        }),
      ),
    ),
  );

  it.live("attaches a concurrent caller to the live owner", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const owner = yield* acquireControl({ stackId: STACK_ID });
          if (owner._tag !== "Owned") throw new Error("expected control ownership");
          const daemonRuntime = ManagedRuntime.make(
            DaemonServer.layerWithShutdown(Effect.void, owner.ownerStatus, {
              includeOwnerRoute: false,
            }).pipe(
              Layer.provide(Layer.succeed(Stack, makeStack({ value: false }))),
              Layer.provide(Layer.succeed(HttpServer.HttpServer, owner.server)),
            ),
          );
          yield* Effect.promise(() => daemonRuntime.runPromise(DaemonServer));
          const contender = yield* acquireControl({ stackId: STACK_ID });
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

  it.live("rejects a valid owner with a colliding deterministic endpoint", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const firstEndpoint = yield* controlEndpoint(STACK_ID);
          const secondEndpoint = yield* controlEndpoint(COLLIDING_STACK_ID);
          expect(secondEndpoint.port).toBe(firstEndpoint.port);
          const owner = yield* acquireControl({ stackId: STACK_ID });
          if (owner._tag !== "Owned") throw new Error("expected control ownership");
          const daemonRuntime = ManagedRuntime.make(
            DaemonServer.layerWithShutdown(Effect.void, owner.ownerStatus, {
              includeOwnerRoute: false,
            }).pipe(
              Layer.provide(Layer.succeed(Stack, makeStack({ value: false }))),
              Layer.provide(Layer.succeed(HttpServer.HttpServer, owner.server)),
            ),
          );
          yield* Effect.promise(() => daemonRuntime.runPromise(DaemonServer));
          const contender = yield* acquireControl({ stackId: COLLIDING_STACK_ID }).pipe(
            Effect.exit,
          );
          expect(Exit.isFailure(contender)).toBe(true);
          if (Exit.isFailure(contender)) {
            expect(Cause.squash(contender.cause)).toMatchObject({
              _tag: "ControlAddressConflictError",
            });
          }
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
            const owner = yield* acquireControl({ stackId: STACK_ID });
            expect(owner._tag).toBe("Owned");
          }),
        );
        const next = yield* Effect.scoped(
          Effect.gen(function* () {
            return yield* acquireControl({ stackId: STACK_ID });
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

  it.live("reports an unavailable control endpoint before the parent handshake expires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unavailable = Layer.succeed(ControlTransport, {
          bind: (endpoint) =>
            Effect.fail(
              new ControlBindError({ endpoint, reason: "in-use" as const, cause: "occupied" }),
            ),
          read: (endpoint) =>
            Effect.fail(
              new ControlTransportError({
                endpoint,
                reason: "unreachable" as const,
                cause: "unavailable",
              }),
            ),
          requestStop: () => Effect.void,
        });
        const exit = yield* acquireControl({ stackId: STACK_ID }).pipe(
          Effect.timeout("2 seconds"),
          Effect.exit,
          Effect.provide(unavailable),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "ControlAddressConflictError",
          });
        }
      }),
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

  it.live("attaches before close and rebinds after close", () =>
    live(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* acquireControl({ stackId: STACK_ID });
          if (owner._tag !== "Owned") throw new Error("expected control ownership");
          const attached = yield* acquireControl({ stackId: STACK_ID });
          expect(attached._tag).toBe("Attached");
          yield* owner.close;
          const next = yield* acquireControl({ stackId: STACK_ID });
          expect(next._tag).toBe("Owned");
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
          const owner = yield* acquireControl({ stackId: STACK_ID });
          expect(owner._tag).toBe("Owned");
        }),
      ),
    ),
  );
});
