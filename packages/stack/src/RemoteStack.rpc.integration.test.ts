import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Stream } from "effect";
import { ServiceNotFoundError, ServiceReadyError } from "@supabase/process-compose";
import { createServer, type Server } from "node:http";
import { expect } from "vitest";
import { Stack, type StackInfo } from "./Stack.ts";
import { StackServiceState } from "./StackServiceState.ts";
import { HttpTransportClient, httpTransportClientLayer } from "./HttpTransportClient.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { StackRpcProtocolError } from "./errors.ts";
import {
  StackBuildError,
  StackNotRunningError,
  StackReadinessError,
  StackUnavailableError,
} from "./errors.ts";
import { acquireControl, isControlOwnership } from "./managed/control.ts";
import { controlTransportLayer } from "./platform-node.ts";
import {
  makeSupervisorControlApplication,
  makeSupervisorControlMiddleware,
} from "./SupervisorControlServer.ts";
import { SupervisorLifecycle } from "./SupervisorLifecycle.ts";
import { makeTestStack } from "./testing.ts";

const ownerId = "b".repeat(64);

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(controlTransportLayer));

const startMalformedServer = (frame: string) =>
  Effect.acquireRelease(
    Effect.callback<
      {
        readonly server: Server;
        readonly endpoint: {
          readonly hostname: string;
          readonly port: number;
          readonly url: string;
        };
      },
      Error
    >((resume) => {
      const server = createServer((request, response) => {
        if (request.url === "/owner") {
          response.writeHead(200, { "content-type": "application/json", connection: "close" });
          response.end(
            JSON.stringify({
              controlProtocol: "supabase-stack-control",
              controlProtocolVersion: 1,
              ownershipId: ownerId,
              ownerSessionId: "malformed-session",
              state: "running",
              ready: true,
              daemonCliVersion: "test",
              daemonBuildId: "test-build",
            }),
          );
          return;
        }
        if (request.url === "/rpc") {
          response.writeHead(200, { "content-type": "application/x-ndjson", connection: "close" });
          response.end(frame);
          return;
        }
        response.writeHead(404, { connection: "close" });
        response.end();
      });
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(Effect.fail(new Error("malformed RPC test server did not expose an address")));
          return;
        }
        resume(
          Effect.succeed({
            server,
            endpoint: {
              hostname: "127.0.0.1",
              port: address.port,
              url: `http://127.0.0.1:${address.port}`,
            },
          }),
        );
      });
      return Effect.sync(() => {
        if (server.listening) server.close();
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        if (!server.listening) {
          resume(Effect.void);
          return Effect.void;
        }
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
  );

const startDisconnectServer = (
  requestStarted: Deferred.Deferred<void>,
  requestClosed: Deferred.Deferred<void>,
) =>
  Effect.acquireRelease(
    Effect.callback<
      {
        readonly server: Server;
        readonly endpoint: {
          readonly hostname: string;
          readonly port: number;
          readonly url: string;
        };
      },
      Error
    >((resume) => {
      const server = createServer((request, response) => {
        if (request.url === "/owner") {
          response.writeHead(200, { "content-type": "application/json", connection: "close" });
          response.end(
            JSON.stringify({
              controlProtocol: "supabase-stack-control",
              controlProtocolVersion: 1,
              ownershipId: ownerId,
              ownerSessionId: "disconnect-session",
              state: "running",
              ready: true,
              daemonCliVersion: "test",
              daemonBuildId: "test-build",
            }),
          );
          return;
        }
        if (request.url === "/rpc") {
          Deferred.doneUnsafe(requestStarted, Effect.void);
          request.once("close", () => {
            Deferred.doneUnsafe(requestClosed, Effect.void);
            response.destroy();
          });
          return;
        }
        response.writeHead(404, { connection: "close" });
        response.end();
      });
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(Effect.fail(new Error("disconnect RPC test server did not expose an address")));
          return;
        }
        resume(
          Effect.succeed({
            server,
            endpoint: {
              hostname: "127.0.0.1",
              port: address.port,
              url: `http://127.0.0.1:${address.port}`,
            },
          }),
        );
      });
      return Effect.sync(() => {
        if (server.listening) server.close();
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        if (!server.listening) {
          resume(Effect.void);
          return Effect.void;
        }
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
  );

it.live("executes every Stack operation over the same-build RPC endpoint", () =>
  live(
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* SupervisorLifecycle.make({
          ownershipId: ownerId,
          ownerSessionId: "rpc-session",
          daemonCliVersion: "test",
          daemonBuildId: "test-build",
        });
        let calls = 0;
        const logReleased = Deferred.makeUnsafe<void>();
        const serviceState = new StackServiceState({
          name: "auth",
          status: "Running",
          pid: 1,
          exitCode: null,
          restartCount: 0,
          startedAt: 1,
          error: null,
        });
        const info: StackInfo = {
          url: "http://127.0.0.1:54321",
          dbUrl: "postgresql://localhost/postgres",
          publishableKey: "publishable",
          secretKey: "secret",
          anonJwt: "anon",
          serviceRoleJwt: "role",
          serviceEndpoints: {},
        };
        const logs = [{ timestamp: 1, service: "auth", stream: "stdout" as const, line: "ready" }];
        const stack: Stack["Service"] = {
          getInfo: () => Effect.succeed(info),
          start: () =>
            Effect.sync(() => {
              calls += 1;
            }),
          stop: () =>
            Effect.sync(() => {
              calls += 1;
            }),
          dispose: () =>
            Effect.sync(() => {
              calls += 1;
            }),
          startService: (name) => {
            switch (name) {
              case "unavailable":
                return Effect.fail(
                  new StackUnavailableError({ phase: "stopping", detail: "stack is stopping" }),
                );
              case "missing":
                return Effect.fail(new ServiceNotFoundError({ name }));
              case "error":
                return Effect.fail(
                  new ServiceReadyError({ name, reason: "did not become ready", exitCode: 17 }),
                );
              case "build":
                return Effect.fail(
                  new StackBuildError({ detail: "docker failed", reason: "docker_not_running" }),
                );
              case "not-running":
                return Effect.fail(new StackNotRunningError({ phase: "stopped" }));
              case "readiness":
                return Effect.fail(
                  new StackReadinessError({ target: "auth", timeoutMs: 1234, detail: "timed out" }),
                );
              default:
                return Effect.sync(() => {
                  calls += 1;
                });
            }
          },
          stopService: () =>
            Effect.sync(() => {
              calls += 1;
            }),
          restartService: () =>
            Effect.sync(() => {
              calls += 1;
            }),
          reloadFunctions: () =>
            Effect.sync(() => {
              calls += 1;
            }),
          reloadEdgeRuntime: () =>
            Effect.sync(() => {
              calls += 1;
            }),
          getState: () => Effect.succeed(serviceState),
          getAllStates: () => Effect.succeed([serviceState]),
          stateChanges: () => Effect.succeed(Stream.fromIterable([serviceState])),
          allStateChanges: () => Stream.fromIterable([serviceState]),
          waitReady: () =>
            Effect.sync(() => {
              calls += 1;
            }),
          waitAllReady: () =>
            Effect.sync(() => {
              calls += 1;
            }),
          subscribeLogs: () =>
            Stream.concat(Stream.fromIterable(logs), Stream.never).pipe(
              Stream.ensuring(Deferred.succeed(logReleased, undefined)),
            ),
          subscribeAllLogs: () => Stream.fromIterable(logs),
          logHistory: () => Effect.succeed(logs),
          logHistoryAll: () => Effect.succeed(logs),
        };
        yield* lifecycle.publishStack(stack);
        const application = {
          app: yield* makeSupervisorControlApplication(lifecycle),
          middleware: makeSupervisorControlMiddleware(lifecycle),
        };
        const owner = yield* acquireControl({
          stackId: ownerId,
          initialStatus: yield* lifecycle.currentStatus,
          application,
        });
        if (!isControlOwnership(owner)) throw new Error("expected ownership");
        yield* lifecycle.setClose(owner.close);
        const ownerStatus = yield* owner.ownerStatus;
        const rpcPaths: Array<string> = [];
        const recordingTransportLayer = Layer.effect(
          HttpTransportClient,
          Effect.gen(function* () {
            const base = yield* HttpTransportClient;
            return {
              request: (
                endpoint: Parameters<HttpTransportClient["Service"]["request"]>[0],
                path: string,
                init?: RequestInit,
              ) =>
                Effect.sync(() => {
                  rpcPaths.push(path);
                }).pipe(Effect.flatMap(() => base.request(endpoint, path, init))),
            };
          }),
        ).pipe(Layer.provide(httpTransportClientLayer));
        const mismatchLayer = RemoteStack.layer(owner.endpoint, {
          buildIdentity: { cliVersion: "test", buildId: "different-build" },
          owner: {
            ownershipId: owner.ownershipId,
            ownerSessionId: ownerStatus.ownerSessionId,
            controlProtocolVersion: ownerStatus.controlProtocolVersion,
            daemonCliVersion: ownerStatus.daemonCliVersion,
            daemonBuildId: ownerStatus.daemonBuildId,
          },
        }).pipe(Layer.provide(recordingTransportLayer));
        const mismatchExit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              yield* Stack;
            }),
          ).pipe(Effect.provide(mismatchLayer)),
        );
        expect(Exit.isFailure(mismatchExit)).toBe(true);
        expect(rpcPaths).toEqual(["/owner"]);
        const remoteLayer = RemoteStack.layer(owner.endpoint, {
          buildIdentity: { cliVersion: "test", buildId: "test-build" },
          owner: {
            ownershipId: owner.ownershipId,
            ownerSessionId: ownerStatus.ownerSessionId,
            controlProtocolVersion: ownerStatus.controlProtocolVersion,
            daemonCliVersion: ownerStatus.daemonCliVersion,
            daemonBuildId: ownerStatus.daemonBuildId,
          },
        }).pipe(Layer.provide(httpTransportClientLayer));
        yield* Effect.gen(function* () {
          const remote = yield* Stack;
          expect(yield* remote.getInfo()).toEqual(info);
          yield* remote.start();
          yield* remote.startService("auth");
          const readyError = yield* Effect.flip(remote.startService("error"));
          expect(readyError).toEqual(
            expect.objectContaining({
              _tag: "ServiceReadyError",
              name: "error",
              reason: "did not become ready",
              exitCode: 17,
            }),
          );
          expect(yield* Effect.flip(remote.startService("unavailable"))).toEqual(
            expect.objectContaining({
              _tag: "StackUnavailableError",
              phase: "stopping",
              detail: "stack is stopping",
            }),
          );
          expect(yield* Effect.flip(remote.startService("missing"))).toEqual(
            expect.objectContaining({
              _tag: "ServiceNotFoundError",
              name: "missing",
            }),
          );
          expect(yield* Effect.flip(remote.startService("build"))).toEqual(
            expect.objectContaining({
              _tag: "StackBuildError",
              detail: "docker failed",
              reason: "docker_not_running",
            }),
          );
          expect(yield* Effect.flip(remote.startService("not-running"))).toEqual(
            expect.objectContaining({
              _tag: "StackNotRunningError",
              phase: "stopped",
            }),
          );
          expect(yield* Effect.flip(remote.startService("readiness"))).toEqual(
            expect.objectContaining({
              _tag: "StackReadinessError",
              target: "auth",
              timeoutMs: 1234,
              detail: "timed out",
            }),
          );
          yield* remote.stopService("auth");
          yield* remote.restartService("auth");
          yield* remote.reloadFunctions();
          yield* remote.reloadEdgeRuntime({ edgeRuntime: { enabled: true } });
          expect(yield* remote.getState("auth")).toEqual(serviceState);
          expect(yield* remote.getAllStates()).toEqual([serviceState]);
          const authChanges = yield* remote.stateChanges("auth");
          expect(yield* Stream.runCollect(authChanges)).toEqual([serviceState]);
          expect(yield* Stream.runCollect(remote.allStateChanges())).toEqual([serviceState]);
          yield* remote.waitReady("auth");
          yield* remote.waitAllReady();
          expect(yield* remote.logHistory("auth")).toEqual(logs);
          expect(yield* remote.logHistoryAll()).toEqual(logs);
          expect(
            yield* Effect.scoped(Stream.runCollect(Stream.take(remote.subscribeLogs("auth"), 1))),
          ).toEqual([logs[0]]);
          yield* Deferred.await(logReleased);
          expect(yield* Stream.runCollect(remote.subscribeAllLogs(["auth"]))).toEqual(logs);
          expect(calls).toBeGreaterThan(0);
          yield* remote.stop();
        }).pipe(Effect.provide(remoteLayer));
      }),
    ),
  ),
);

it.live.each([
  ["malformed NDJSON", "not-json\n"],
  ["incomplete NDJSON", '{"_tag":"RpcResponse","success":'],
] as const)("preserves endpoint and procedure for %s", ([_label, frame]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* startMalformedServer(frame);
      const layer = RemoteStack.layer(server.endpoint, {
        buildIdentity: { cliVersion: "test", buildId: "test-build" },
        owner: {
          ownershipId: ownerId,
          ownerSessionId: "malformed-session",
          controlProtocolVersion: 1,
          daemonCliVersion: "test",
          daemonBuildId: "test-build",
        },
      }).pipe(Layer.provide(httpTransportClientLayer));
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const remote = yield* Stack;
          yield* remote.getInfo();
        }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(StackRpcProtocolError);
          expect(Predicate.isTagged(failure.value, "StackRpcProtocolError")).toBe(true);
          expect(failure.value).toMatchObject({
            endpoint: server.endpoint.url,
            procedure: "GetInfo",
          });
        }
      }
    }),
  ).pipe(Effect.provide(controlTransportLayer)),
);

it.live("interrupts an owned server RPC request when the client disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requestStarted = Deferred.makeUnsafe<void>();
      const requestClosed = Deferred.makeUnsafe<void>();
      const server = yield* startDisconnectServer(requestStarted, requestClosed);
      const layer = RemoteStack.layer(server.endpoint, {
        buildIdentity: { cliVersion: "test", buildId: "test-build" },
        owner: {
          ownershipId: ownerId,
          ownerSessionId: "disconnect-session",
          controlProtocolVersion: 1,
          daemonCliVersion: "test",
          daemonBuildId: "test-build",
        },
      }).pipe(Layer.provide(httpTransportClientLayer));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const remote = yield* Stack;
          const request = yield* Effect.forkChild(remote.getInfo());
          yield* Deferred.await(requestStarted);
          yield* Fiber.interrupt(request);
          yield* Deferred.await(requestClosed);
        }).pipe(Effect.provide(layer)),
      );
    }),
  ).pipe(Effect.provide(controlTransportLayer)),
);

it.live("interrupts the real RPC handler fiber when the client request is canceled", () =>
  live(
    Effect.scoped(
      Effect.gen(function* () {
        const started = Deferred.makeUnsafe<void>();
        const finalized = Deferred.makeUnsafe<void>();
        const info: StackInfo = {
          url: "http://127.0.0.1:54321",
          dbUrl: "postgresql://localhost/postgres",
          publishableKey: "publishable",
          secretKey: "secret",
          anonJwt: "anon",
          serviceRoleJwt: "role",
          serviceEndpoints: {},
        };
        const stack: Stack["Service"] = {
          ...makeTestStack(),
          getInfo: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined)),
              Effect.as(info),
            ),
        };
        const lifecycle = yield* SupervisorLifecycle.make({
          ownershipId: ownerId,
          ownerSessionId: "rpc-cancel-session",
          daemonCliVersion: "test",
          daemonBuildId: "test-build",
        });
        yield* lifecycle.publishStack(stack);
        const application = {
          app: yield* makeSupervisorControlApplication(lifecycle),
          middleware: makeSupervisorControlMiddleware(lifecycle),
        };
        const owner = yield* acquireControl({
          stackId: ownerId,
          initialStatus: yield* lifecycle.currentStatus,
          application,
        });
        if (!isControlOwnership(owner)) throw new Error("expected ownership");
        yield* lifecycle.setClose(owner.close);
        const ownerStatus = yield* owner.ownerStatus;
        const layer = RemoteStack.layer(owner.endpoint, {
          buildIdentity: { cliVersion: "test", buildId: "test-build" },
          owner: {
            ownershipId: owner.ownershipId,
            ownerSessionId: ownerStatus.ownerSessionId,
            controlProtocolVersion: ownerStatus.controlProtocolVersion,
            daemonCliVersion: ownerStatus.daemonCliVersion,
            daemonBuildId: ownerStatus.daemonBuildId,
          },
        }).pipe(Layer.provide(httpTransportClientLayer));
        yield* Effect.gen(function* () {
          const remote = yield* Stack;
          const request = yield* Effect.forkChild(remote.getInfo());
          yield* Deferred.await(started);
          yield* Fiber.interrupt(request);
          yield* Deferred.await(finalized);
        }).pipe(Effect.provide(layer));
      }),
    ),
  ),
);
