import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Predicate, Result, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { describe, expect } from "vitest";
import {
  acquireControl,
  CONTROL_CANDIDATE_COUNT,
  controlEndpoint,
  controlEndpointCandidates,
  ControlBindError,
  type ControlOwnerStatus,
  ControlTransport,
  type ControlTransportShape,
  ControlTransportError,
  isControlAttached,
  isControlOwnership,
  probeControl,
  readControlOwnerStatus,
  requestControlStopForSession,
} from "./managed/control.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { Stack } from "./Stack.ts";
import { SupervisorControlServer } from "./SupervisorControlServer.ts";
import { SupervisorLifecycle } from "./SupervisorLifecycle.ts";

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

const makeStaticOwner = (stackId: string, stack: Stack["Service"]) =>
  Effect.gen(function* () {
    const ownerSessionId = crypto.randomUUID();
    const lifecycle = yield* SupervisorLifecycle.make({
      ownershipId: stackId,
      ownerSessionId,
      daemonCliVersion: "test",
      close: Effect.void,
    });
    const application = {
      app: yield* SupervisorControlServer.make(lifecycle),
    };
    const owner = yield* acquireControl({
      stackId,
      initialStatus: {
        controlProtocol: "supabase-stack-control",
        controlProtocolVersion: 1,
        ownershipId: stackId,
        ownerSessionId,
        state: "starting",
        ready: false,
        daemonCliVersion: "test",
      },
      application,
    });
    if (!isControlOwnership(owner)) throw new Error("expected control ownership");
    yield* lifecycle.setClose(owner.close);
    yield* lifecycle.publishStack(stack);
    return { lifecycle, owner };
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

const listenNonHttp = (
  port: number,
): Promise<{ readonly server: TcpServer; readonly close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.end("not-http\r\n");
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        server,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            for (const socket of sockets) socket.destroy();
            server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
          }),
      }),
    );
  });

const closeRaw = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

it.effect("canonical owner reads retain foreign-owner conflict diagnostics", () =>
  Effect.gen(function* () {
    const endpoint = yield* controlEndpoint(STACK_ID);
    const result = yield* readControlOwnerStatus(endpoint, STACK_ID, () =>
      Effect.succeed({
        controlProtocol: "supabase-stack-control",
        controlProtocolVersion: 1,
        ownershipId: "f".repeat(64),
        ownerSessionId: "foreign-session",
        state: "running",
        ready: true,
        daemonCliVersion: "foreign",
      }),
    ).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, "ControlAddressConflictError")).toBe(true);
    }
  }),
);

const spawnBoundChild = (port: number) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'const http=require("node:http"); const server=http.createServer((_req,res)=>res.end("child")); server.listen(Number(process.argv[1]), "127.0.0.1", () => process.send?.("ready"));',
      String(port),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Uint8Array) => {
    stderr += new TextDecoder().decode(chunk);
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`child exited before ready: ${code}\n${stderr || "(no stderr)"}`)),
    );
    child.on("message", (message) => {
      if (message === "ready") resolve();
    });
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return { child, ready, exited };
};

describe("managed control endpoint", () => {
  it.live("derives deterministic loopback candidates from the ownership id", () => {
    return Effect.sync(() => {
      const endpoint = Effect.runSync(controlEndpoint(STACK_ID));
      expect(endpoint.url).toBe("http://127.0.0.1:13737");
      const candidates = Effect.runSync(controlEndpointCandidates(STACK_ID));
      expect(candidates).toHaveLength(CONTROL_CANDIDATE_COUNT);
      expect(candidates.map(({ port }) => port)).toEqual(
        Array.from({ length: CONTROL_CANDIDATE_COUNT }, (_, offset) => 13737 + offset),
      );
    });
  });

  it.live("serves the static supervisor application on the owned listener", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const started = { value: false };
          const stack = makeStack(started);
          const { owner } = yield* makeStaticOwner(STACK_ID, stack);
          expect(started.value).toBe(false);
          const response = yield* Effect.promise(() => fetch(`${owner.endpoint.url}/owner`));
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            ownershipId: STACK_ID,
            state: "running",
            ready: true,
          });
        }),
      ),
    ),
  );

  it.live(
    "publishes owner status before and after runtime publication on the static listener",
    () =>
      Effect.scoped(
        live(
          Effect.gen(function* () {
            const lifecycle = yield* SupervisorLifecycle.make({
              ownershipId: STACK_ID,
              ownerSessionId: crypto.randomUUID(),
              daemonCliVersion: "test",
              close: Effect.void,
            });
            const application = {
              app: yield* SupervisorControlServer.make(lifecycle),
            };
            const owner = yield* acquireControl({ stackId: STACK_ID, application });
            if (!isControlOwnership(owner)) throw new Error("expected control ownership");
            yield* lifecycle.setClose(owner.close);
            const before = yield* Effect.promise(() => fetch(`${owner.endpoint.url}/owner`));
            expect(before.status).toBe(200);
            expect(yield* Effect.promise(() => before.json())).toMatchObject({ state: "starting" });
            yield* lifecycle.publishStack(makeStack({ value: false }));
            const after = yield* Effect.promise(() => fetch(`${owner.endpoint.url}/owner`));
            expect(yield* Effect.promise(() => after.json())).toMatchObject({
              state: "running",
              ready: true,
            });
            yield* owner.close;
          }),
        ),
      ),
  );

  it.live("hands a fenced stop request to the supervisor shutdown transaction exactly once", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const stopCalls = { value: 0 };
          const stack = {
            ...makeStack({ value: false }),
            stop: () =>
              Effect.sync(() => {
                stopCalls.value += 1;
              }),
          } satisfies Stack["Service"];
          const { owner, lifecycle } = yield* makeStaticOwner(STACK_ID, stack);
          const ownerStatus = yield* lifecycle.currentStatus;

          const response = yield* Effect.promise(() =>
            fetch(`${owner.endpoint.url}/stop`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ownershipId: STACK_ID,
                ownerSessionId: ownerStatus.ownerSessionId,
              }),
            }),
          );
          expect(response.status).toBe(202);
          expect(yield* Effect.promise(() => response.json())).toEqual({ ok: true });
          yield* lifecycle.awaitShutdown;
          expect(stopCalls.value).toBe(1);
        }),
      ),
    ),
  );

  it.live("attaches a concurrent caller to the live owner", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          yield* makeStaticOwner(STACK_ID, makeStack({ value: false }));
          const contender = yield* acquireControl({ stackId: STACK_ID });
          expect(isControlAttached(contender)).toBe(true);
          expect(yield* contender.ownerStatus).toMatchObject({
            controlProtocolVersion: 1,
            state: "running",
            ready: true,
          });
        }),
      ),
    ),
  );

  it.live("claims the next candidate when another stack owns the first", () =>
    Effect.scoped(
      live(
        Effect.gen(function* () {
          const firstEndpoint = yield* controlEndpoint(STACK_ID);
          const secondEndpoint = yield* controlEndpoint(COLLIDING_STACK_ID);
          expect(secondEndpoint.port).toBe(firstEndpoint.port);
          const owner = yield* acquireControl({ stackId: STACK_ID });
          if (!isControlOwnership(owner)) throw new Error("expected control ownership");
          const contender = yield* acquireControl({ stackId: COLLIDING_STACK_ID });
          if (!isControlOwnership(contender)) throw new Error("expected contender ownership");
          expect(contender.endpoint.port).not.toBe(owner.endpoint.port);

          // Readers locate each owner at its actual candidate.
          const ownerProbe = yield* probeControl(STACK_ID);
          expect(ownerProbe?.endpoint.port).toBe(owner.endpoint.port);
          const contenderProbe = yield* probeControl(COLLIDING_STACK_ID);
          expect(contenderProbe?.endpoint.port).toBe(contender.endpoint.port);

          // A second caller for the collided stack attaches to its owner.
          const attached = yield* acquireControl({ stackId: COLLIDING_STACK_ID });
          expect(isControlAttached(attached)).toBe(true);
          expect(attached.endpoint.port).toBe(contender.endpoint.port);
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
            expect(isControlOwnership(owner)).toBe(true);
          }),
        );
        const next = yield* Effect.scoped(
          Effect.gen(function* () {
            return yield* acquireControl({ stackId: STACK_ID });
          }),
        );
        expect(isControlOwnership(next)).toBe(true);
      }),
    ),
  );

  it.live("claims the next candidate without taking over an unrelated listener", () =>
    live(
      Effect.scoped(
        Effect.gen(function* () {
          const candidates = yield* controlEndpointCandidates(STACK_ID);
          const unrelated = yield* Effect.acquireRelease(
            Effect.promise(() => listenRaw(candidates[0]!.port)),
            (server) => Effect.promise(() => closeRaw(server)),
          );
          const owner = yield* acquireControl({ stackId: STACK_ID });
          if (!isControlOwnership(owner)) throw new Error("expected control ownership");
          expect(owner.endpoint.port).toBe(candidates[1]!.port);
          expect(unrelated.listening).toBe(true);
          const probe = yield* probeControl(STACK_ID);
          expect(probe?.endpoint.port).toBe(candidates[1]!.port);
        }),
      ),
    ),
  );

  it.live("starts on the next candidate when another stack service is not HTTP", () =>
    live(
      Effect.scoped(
        Effect.gen(function* () {
          const candidates = yield* controlEndpointCandidates(STACK_ID);
          const unrelated = yield* Effect.acquireRelease(
            Effect.promise(() => listenNonHttp(candidates[0]!.port)),
            (listener) => Effect.promise(() => listener.close()),
          );
          const owner = yield* acquireControl({ stackId: STACK_ID });
          if (!isControlOwnership(owner)) throw new Error("expected control ownership");
          expect(owner.endpoint.port).toBe(candidates[1]!.port);
          expect(unrelated.server.listening).toBe(true);
        }),
      ),
    ),
  );

  it.live("fails once every candidate is occupied by unrelated listeners", () =>
    live(
      Effect.scoped(
        Effect.gen(function* () {
          const candidates = yield* controlEndpointCandidates(STACK_ID);
          yield* Effect.forEach(candidates, (candidate) =>
            Effect.acquireRelease(
              Effect.promise(() => listenRaw(candidate.port)),
              (server) => Effect.promise(() => closeRaw(server)),
            ),
          );
          const result = yield* acquireControl({ stackId: STACK_ID }).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(Predicate.isTagged(result.failure, "ControlAddressConflictError")).toBe(true);
          }
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
          Effect.timeout("10 seconds"),
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

  it.effect("retries an unreachable owner candidate before considering later candidates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const candidates = yield* controlEndpointCandidates(STACK_ID);
        const ownerEndpoint = candidates[0]!;
        const ownerStatus: ControlOwnerStatus = {
          controlProtocol: "supabase-stack-control",
          controlProtocolVersion: 1,
          ownershipId: STACK_ID,
          ownerSessionId: "owner-session",
          state: "running",
          ready: true,
          daemonCliVersion: "old",
        };
        const attachUnavailable = yield* Deferred.make<void>();
        let ownerReads = 0;
        const attemptedBinds: Array<number> = [];
        const transport = Layer.succeed(ControlTransport, {
          bind: (endpoint) => {
            attemptedBinds.push(endpoint.port);
            return Effect.fail(
              new ControlBindError({
                endpoint,
                reason: endpoint.port === ownerEndpoint.port ? "in-use" : "failed",
                cause: new Error(
                  endpoint.port === ownerEndpoint.port
                    ? "owner is listening"
                    : "must not bind a later candidate while the owner is unreachable",
                ),
              }),
            );
          },
          read: (endpoint) => {
            if (endpoint.port !== ownerEndpoint.port) {
              return Effect.fail(
                new ControlTransportError({
                  endpoint,
                  reason: "unreachable",
                  cause: new Error("candidate is free"),
                }),
              );
            }
            ownerReads += 1;
            if (ownerReads > 2) return Effect.succeed(ownerStatus);
            return (
              ownerReads === 2 ? Deferred.succeed(attachUnavailable, undefined) : Effect.void
            ).pipe(
              Effect.andThen(
                Effect.fail(
                  new ControlTransportError({
                    endpoint,
                    reason: "unreachable",
                    cause: new Error("owner handshake is temporarily unavailable"),
                  }),
                ),
              ),
            );
          },
          requestStop: () => Effect.void,
        });
        const pending = yield* acquireControl({ stackId: STACK_ID }).pipe(
          Effect.provide(transport),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(attachUnavailable);
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;
        const result = yield* Fiber.join(pending).pipe(Effect.result);

        expect(Result.isSuccess(result)).toBe(true);
        if (Result.isSuccess(result)) {
          expect(isControlAttached(result.success)).toBe(true);
          expect(result.success.endpoint).toEqual(ownerEndpoint);
        }
        expect(attemptedBinds).toEqual([ownerEndpoint.port]);
      }),
    ),
  );

  it.live("fails closed when an owner probe encounters ambiguous transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reads = 0;
        const transport = Layer.succeed(ControlTransport, {
          bind: (endpoint) =>
            Effect.fail(
              new ControlBindError({ endpoint, reason: "in-use" as const, cause: "occupied" }),
            ),
          read: (endpoint) =>
            Effect.fail(
              new ControlTransportError({
                endpoint,
                reason: reads++ === 0 ? ("transport" as const) : ("unreachable" as const),
                cause: "probe failed",
              }),
            ),
          requestStop: () => Effect.void,
        });
        const exit = yield* acquireControl({ stackId: STACK_ID }).pipe(
          Effect.result,
          Effect.provide(transport),
        );
        expect(Result.isFailure(exit)).toBe(true);
        if (Result.isFailure(exit)) {
          expect(exit.failure).toBeInstanceOf(ControlTransportError);
          if (exit.failure instanceof ControlTransportError) {
            expect(exit.failure.reason).toBe("transport");
          }
        }
      }),
    ),
  );

  it.effect("observes the original session after an ambiguous stop delivery", () =>
    Effect.gen(function* () {
      const endpoint = yield* controlEndpoint(STACK_ID);
      const ownerSessionId = "owner-session";
      const status: ControlOwnerStatus = {
        controlProtocol: "supabase-stack-control",
        controlProtocolVersion: 1,
        ownershipId: STACK_ID,
        ownerSessionId,
        state: "running",
        ready: true,
        daemonCliVersion: "test",
      };
      let requestCalls = 0;
      let reads = 0;
      const transport: ControlTransportShape = {
        bind: () => Effect.die("unused"),
        read: () =>
          Effect.sync(() => {
            reads += 1;
            return status;
          }),
        requestStop: (requestEndpoint) =>
          Effect.sync(() => {
            requestCalls += 1;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ControlTransportError({
                  endpoint: requestEndpoint,
                  reason: "transport",
                  cause: new Error("simulated connection reset after POST delivery"),
                }),
              ),
            ),
          ),
      };
      const pending = yield* requestControlStopForSession(
        endpoint,
        STACK_ID,
        ownerSessionId,
        transport,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;

      const result = yield* Fiber.join(pending).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(
          Predicate.isTagged(result.failure, "StopTimeout"),
          `expected StopTimeout, received ${String(result.failure)}`,
        ).toBe(true);
        if (Predicate.isTagged(result.failure, "StopTimeout")) {
          expect(result.failure.lastState).toBe("running");
        }
      }
      expect(requestCalls).toBe(1);
      expect(reads).toBeGreaterThan(0);
    }),
  );

  it.effect("retries an ambiguous observation until the exact session changes", () =>
    Effect.gen(function* () {
      const endpoint = yield* controlEndpoint(STACK_ID);
      const ownerSessionId = "owner-session";
      const readStarted = yield* Deferred.make<void>();
      const status: ControlOwnerStatus = {
        controlProtocol: "supabase-stack-control",
        controlProtocolVersion: 1,
        ownershipId: STACK_ID,
        ownerSessionId,
        state: "stopping",
        ready: false,
        daemonCliVersion: "test",
      };
      const replacementStatus = { ...status, ownerSessionId: "replacement-session" };
      let reads = 0;
      const transport: ControlTransportShape = {
        bind: () => Effect.die("unused"),
        read: (readEndpoint) => {
          return Effect.sync(() => {
            reads += 1;
            return reads;
          }).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Deferred.succeed(readStarted, void 0).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new ControlTransportError({
                          endpoint: readEndpoint,
                          reason: "transport",
                          cause: new Error("simulated observation reset"),
                        }),
                      ),
                    ),
                  )
                : Effect.succeed(replacementStatus),
            ),
          );
        },
        requestStop: () => Effect.void,
      };
      const pending = yield* requestControlStopForSession(
        endpoint,
        STACK_ID,
        ownerSessionId,
        transport,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(readStarted);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      for (let attempt = 0; attempt < 8 && reads < 2; attempt += 1) {
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
      }
      const result = yield* Fiber.join(pending).pipe(Effect.result);
      expect(Result.isSuccess(result)).toBe(true);
      expect(reads).toBe(2);
    }),
  );

  it.effect("completes when another stack rebinds the stopped owner's endpoint", () =>
    Effect.gen(function* () {
      const endpoint = yield* controlEndpoint(STACK_ID);
      const ownerSessionId = "owner-session";
      const foreignStatus: ControlOwnerStatus = {
        controlProtocol: "supabase-stack-control",
        controlProtocolVersion: 1,
        ownershipId: "f".repeat(64),
        ownerSessionId: "foreign-session",
        state: "running",
        ready: true,
        daemonCliVersion: "test",
      };
      const transport: ControlTransportShape = {
        bind: () => Effect.die("unused"),
        read: () => Effect.succeed(foreignStatus),
        requestStop: () => Effect.void,
      };

      const result = yield* requestControlStopForSession(
        endpoint,
        STACK_ID,
        ownerSessionId,
        transport,
      ).pipe(Effect.result);

      expect(Result.isSuccess(result)).toBe(true);
    }),
  );

  it.live("treats a post-stop non-control response as proof that the captured session ended", () =>
    Effect.forEach(["malformed", "protocol-mismatch"] as const, (replacementKind) =>
      Effect.gen(function* () {
        const endpoint = yield* controlEndpoint(STACK_ID);
        const ownerSessionId = "owner-session";
        const oldListenerClosed = yield* Deferred.make<void>();
        const replacementBound = yield* Deferred.make<void>();
        let stopRequests = 0;
        let reads = 0;
        const transport: ControlTransportShape = {
          bind: () => Effect.die("unused"),
          requestStop: () =>
            Effect.sync(() => {
              stopRequests += 1;
            }).pipe(
              // Model the supervisor's ordered teardown and the unrelated
              // listener rebinding before the first post-stop read.
              Effect.andThen(Deferred.succeed(oldListenerClosed, undefined)),
              Effect.andThen(Deferred.succeed(replacementBound, undefined)),
            ),
          read: () =>
            Effect.gen(function* () {
              yield* Deferred.await(oldListenerClosed);
              yield* Deferred.await(replacementBound);
              reads += 1;
              if (replacementKind === "malformed") {
                return "not-supabase";
              }
              return {
                controlProtocol: "supabase-stack-control",
                controlProtocolVersion: 2,
                ownershipId: STACK_ID,
                ownerSessionId: "replacement-session",
                state: "running",
                ready: true,
                daemonCliVersion: "foreign",
              };
            }),
        };

        const result = yield* requestControlStopForSession(
          endpoint,
          STACK_ID,
          ownerSessionId,
          transport,
        ).pipe(Effect.result);
        expect(Result.isSuccess(result)).toBe(true);
        expect(stopRequests).toBe(1);
        expect(reads).toBe(1);
      }),
    ).pipe(Effect.asVoid),
  );

  it.effect("retains the verified attach status when a later live read is unreachable", () =>
    Effect.gen(function* () {
      const endpoint = yield* controlEndpoint(STACK_ID);
      const status: ControlOwnerStatus = {
        controlProtocol: "supabase-stack-control",
        controlProtocolVersion: 1,
        ownershipId: STACK_ID,
        ownerSessionId: "owner-session",
        state: "running",
        ready: true,
        daemonCliVersion: "test",
      };
      let reads = 0;
      const transport: ControlTransportShape = {
        bind: () => Effect.die("unused"),
        read: (readEndpoint) =>
          Effect.suspend(() => {
            reads += 1;
            return reads === 1
              ? Effect.succeed(status)
              : Effect.fail(
                  new ControlTransportError({
                    endpoint: readEndpoint,
                    reason: "unreachable",
                    cause: new Error("owner closed after attach handshake"),
                  }),
                );
          }),
        requestStop: () => Effect.void,
      };
      const attached = yield* acquireControl({ stackId: STACK_ID }).pipe(
        Effect.provideService(ControlTransport, transport),
      );
      expect(isControlAttached(attached)).toBe(true);
      if (!isControlAttached(attached)) return;
      expect(attached.observedStatus).toEqual(status);
      const liveStatus = yield* attached.ownerStatus.pipe(Effect.result);
      expect(Result.isFailure(liveStatus)).toBe(true);
      expect(reads).toBe(2);
      expect(endpoint.port).toBe(attached.endpoint.port);
    }),
  );

  it.effect("stops only the owner session verified by the attach handshake", () =>
    Effect.gen(function* () {
      const attachedStatus: ControlOwnerStatus = {
        controlProtocol: "supabase-stack-control",
        controlProtocolVersion: 1,
        ownershipId: STACK_ID,
        ownerSessionId: "attached-session",
        state: "running",
        ready: true,
        daemonCliVersion: "old",
      };
      const replacementStatus: ControlOwnerStatus = {
        ...attachedStatus,
        ownerSessionId: "replacement-session",
        daemonCliVersion: "new",
      };
      let reads = 0;
      let requestedSession: string | undefined;
      const transport: ControlTransportShape = {
        bind: () => Effect.die("unused"),
        read: () => Effect.sync(() => (reads++ === 0 ? attachedStatus : replacementStatus)),
        requestStop: (_requestEndpoint, request) =>
          Effect.sync(() => {
            requestedSession = request.ownerSessionId;
          }),
      };
      const attached = yield* acquireControl({ stackId: STACK_ID }).pipe(
        Effect.provideService(ControlTransport, transport),
      );
      expect(isControlAttached(attached)).toBe(true);
      if (!isControlAttached(attached)) return;

      yield* attached.requestStop;

      expect(requestedSession).toBe("attached-session");
    }),
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
                JSON.stringify({
                  controlProtocol: "supabase-stack-control",
                  controlProtocolVersion: 2,
                  ownershipId: STACK_ID,
                  ownerSessionId: "foreign",
                  state: "running",
                  ready: true,
                  daemonCliVersion: "foreign",
                }),
              ),
            ),
            (server) => Effect.promise(() => closeRaw(server)),
          );
          const result = yield* acquireControl({ stackId: STACK_ID }).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(Predicate.isTagged(result.failure, "ControlProtocolMismatchError")).toBe(true);
          }
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
          if (!isControlOwnership(owner)) throw new Error("expected control ownership");
          const attached = yield* acquireControl({ stackId: STACK_ID });
          expect(isControlAttached(attached)).toBe(true);
          yield* owner.close;
          const next = yield* acquireControl({ stackId: STACK_ID });
          expect(isControlOwnership(next)).toBe(true);
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
          expect(isControlOwnership(owner)).toBe(true);
        }),
      ),
    ),
  );
});
