// oxlint-disable effecttsgo/global-fetch-in-effect, effecttsgo/prefer-schema-over-json -- Handler integration tests drive raw HTTP payloads to validate the RPC protocol boundary.
import { ServiceNotFoundError } from "@supabase/process-compose";
import { it } from "@effect/vitest";
import {
  Context,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Semaphore,
  Stream,
} from "effect";
import { expect } from "vitest";
import { httpTransportClientLayer } from "./HttpTransportClient.ts";
import { RemoteStack, updateRemoteLaunch } from "./RemoteStack.ts";
import { Stack } from "./Stack.ts";
import { StackBuildError, StackUnavailableError } from "./errors.ts";
import { acquireControl, isControlOwnership } from "./managed/control.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { makeSupervisorControlApplication } from "./SupervisorControlServer.ts";
import { makeSupervisorSessionFixture } from "../tests/helpers/SupervisorSessionFixture.ts";
import { StackServiceState } from "./StackServiceState.ts";
import { stackRpcFenceHeaders } from "./StackRpc.ts";
import { isControlSupervisorStatus, type ControlOwnerStatus } from "./DaemonProtocol.ts";
import { makeTestStack } from "./testing.ts";

const OWNER_ID = "e".repeat(64);

const supervisorStatus = (status: ControlOwnerStatus) => {
  if (!isControlSupervisorStatus(status)) throw new Error("expected supervisor status");
  return status;
};

const serviceState = (name: string) =>
  new StackServiceState({
    name,
    status: "Running",
    pid: 1,
    exitCode: null,
    restartCount: 0,
    startedAt: 1,
    error: null,
  });

const logs = [
  { timestamp: 1, service: "postgres", stream: "stdout" as const, line: "postgres starting" },
  { timestamp: 2, service: "auth", stream: "stdout" as const, line: "auth starting" },
  { timestamp: 3, service: "postgres", stream: "stdout" as const, line: "postgres ready" },
  { timestamp: 4, service: "auth", stream: "stdout" as const, line: "auth ready" },
  { timestamp: 5, service: "auth", stream: "stdout" as const, line: "auth accepting" },
  { timestamp: 6, service: "storage", stream: "stdout" as const, line: "storage ready" },
];

const stack: Stack["Service"] = makeTestStack({
  getInfo: Effect.succeed({
    url: "http://127.0.0.1:54321",
    dbUrl: "postgresql://localhost/postgres",
    publishableKey: "publishable",
    secretKey: "secret",
    anonJwt: "anon",
    serviceRoleJwt: "role",
    serviceEndpoints: {},
  }),
  reloadFunctions: () =>
    Effect.fail(
      new StackBuildError({
        detail: "Invalid Edge Functions reload payload",
        reason: "invalid_config",
      }),
    ),
  getState: (name) =>
    name === "postgres" || name === "auth"
      ? Effect.succeed(serviceState(name))
      : Effect.fail(new ServiceNotFoundError({ name })),
  getAllStates: Effect.succeed([serviceState("postgres"), serviceState("auth")]),
  stateChanges: (name) => Effect.succeed(Stream.fromIterable([serviceState(name)])),
  allStateChanges: Stream.fromIterable([serviceState("postgres"), serviceState("auth")]),
  subscribeLogs: (name) => Stream.fromIterable(logs.filter((entry) => entry.service === name)),
  subscribeAllLogs: (services) =>
    Stream.fromIterable(
      services === undefined || services.length === 0
        ? logs
        : logs.filter((entry) => services.includes(entry.service)),
    ),
  logHistory: (name, limit) =>
    Effect.succeed(logs.filter((entry) => entry.service === name).slice(-(limit ?? 100))),
  logHistoryAll: (limit, services) =>
    Effect.succeed(
      (services === undefined || services.length === 0
        ? logs
        : logs.filter((entry) => services.includes(entry.service))
      ).slice(-(limit ?? 100)),
    ),
});

it.live("serves handler behavior over the RPC boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeSupervisorSessionFixture({
        ownershipId: OWNER_ID,
        ownerSessionId: "handler-session",
        daemonCliVersion: "test",
      });
      const application = {
        app: yield* makeSupervisorControlApplication(lifecycle),
      };
      const owner = yield* acquireControl({
        stackId: OWNER_ID,
        initialStatus: yield* lifecycle.currentStatus,
        application,
      });
      if (!isControlOwnership(owner)) throw new Error("expected control ownership");
      yield* lifecycle.setClose(owner.close);
      const status = supervisorStatus(yield* lifecycle.currentStatus);
      const layer = RemoteStack.layer(owner.endpoint, {
        cliVersion: "test",
        owner: {
          ownershipId: OWNER_ID,
          ownerSessionId: status.ownerSessionId,
          controlProtocolVersion: status.controlProtocolVersion,
          daemonCliVersion: status.daemonCliVersion,
        },
      }).pipe(Layer.provide(httpTransportClientLayer));
      const remote = yield* Layer.build(layer).pipe(
        Effect.map((context) => Context.get(context, Stack)),
      );

      const unavailable = yield* Effect.flip(remote.getInfo);
      expect(Predicate.isTagged(unavailable, "StackUnavailableError")).toBe(true);
      if (Predicate.isTagged(unavailable, "StackUnavailableError")) {
        expect(unavailable.phase).toBe("starting");
      }
      yield* lifecycle.publishStack(stack);
      expect((yield* remote.getInfo).url).toBe("http://127.0.0.1:54321");

      const history = yield* remote.logHistoryAll(3, ["postgres", "auth"]);
      expect(history.map((entry) => entry.line)).toEqual([
        "postgres ready",
        "auth ready",
        "auth accepting",
      ]);

      const rawReload = yield* Effect.promise(() =>
        fetch(`${owner.endpoint.url}/rpc`, {
          method: "POST",
          headers: {
            "content-type": "application/ndjson",
            ...stackRpcFenceHeaders({
              ownershipId: status.ownershipId,
              ownerSessionId: status.ownerSessionId,
            }),
          },
          body: `${JSON.stringify({
            _tag: "Request",
            id: "redaction-test",
            tag: "ReloadFunctions",
            payload: {
              options: {
                functions: {
                  env: { SECRET: "must-not-appear-in-errors" },
                  functions: [
                    {
                      name: "hello",
                      verifyJWT: false,
                      entrypointPath: "relative/index.ts",
                      importMapPath: null,
                      staticFiles: [],
                      env: {},
                    },
                  ],
                },
              },
            },
            headers: [],
          })}\n`,
        }),
      );
      const rawBody = yield* Effect.promise(() => rawReload.text());
      expect(rawReload.status).toBe(200);
      expect(rawBody.length).toBeGreaterThan(0);
      expect(rawBody).toContain("entrypointPath");
      expect(rawBody).not.toContain("must-not-appear-in-errors");
      expect(rawBody).not.toContain("relative/index.ts");
    }).pipe(Effect.provide(controlTransportLayer)),
  ),
);

it.live("rejects launch updates after supervisor shutdown begins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeSupervisorSessionFixture({
        ownershipId: OWNER_ID,
        ownerSessionId: "launch-update-session",
        daemonCliVersion: "test",
      });
      const updates: Array<string> = [];
      const application = {
        app: yield* makeSupervisorControlApplication(lifecycle, {
          update: (stackId) =>
            Effect.sync(() => {
              updates.push(stackId);
            }),
        }),
      };
      const owner = yield* acquireControl({
        stackId: OWNER_ID,
        initialStatus: yield* lifecycle.currentStatus,
        application,
      });
      if (!isControlOwnership(owner)) throw new Error("expected control ownership");
      yield* lifecycle.setClose(owner.close);
      const status = supervisorStatus(yield* lifecycle.currentStatus);
      const stopStarted = yield* Deferred.make<void>();
      const releaseStop = yield* Deferred.make<void>();
      yield* lifecycle.publishStack({
        ...stack,
        stop: Deferred.succeed(stopStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseStop)),
        ),
      });

      yield* Effect.gen(function* () {
        yield* lifecycle.submitShutdownWithIntent("explicit");
        yield* Deferred.await(stopStarted);
        const unavailable = yield* Effect.flip(
          updateRemoteLaunch(
            owner.endpoint,
            {
              cliVersion: "test",
              owner: {
                ownershipId: status.ownershipId,
                ownerSessionId: status.ownerSessionId,
                controlProtocolVersion: status.controlProtocolVersion,
                daemonCliVersion: status.daemonCliVersion,
              },
            },
            OWNER_ID,
            { versions: { postgres: "17.6.1.076" } },
          ),
        );
        expect(Predicate.isTagged(unavailable, "StackUnavailableError")).toBe(true);
        if (Predicate.isTagged(unavailable, "StackUnavailableError")) {
          expect(unavailable.phase).toBe("stopping");
        }
        expect(updates).toEqual([]);
      }).pipe(Effect.ensuring(Deferred.succeed(releaseStop, undefined).pipe(Effect.asVoid)));
      yield* lifecycle.awaitShutdown;
    }).pipe(Effect.provide(Layer.mergeAll(controlTransportLayer, httpTransportClientLayer))),
  ),
);

it.live("propagates a failure terminal reason to an active state stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const streamStarted = Deferred.makeUnsafe<void>();
      const releaseStop = Deferred.makeUnsafe<void>();
      const lifecycle = yield* makeSupervisorSessionFixture({
        ownershipId: OWNER_ID,
        ownerSessionId: "failure-stream-session",
        daemonCliVersion: "test",
      });
      yield* lifecycle.publishStack({
        ...stack,
        stop: Deferred.await(releaseStop),
        allStateChanges: Stream.concat(
          Stream.succeed(serviceState("auth")).pipe(
            Stream.tap(() => Deferred.succeed(streamStarted, undefined).pipe(Effect.asVoid)),
          ),
          Stream.never,
        ),
      });
      const application = { app: yield* makeSupervisorControlApplication(lifecycle) };
      const owner = yield* acquireControl({
        stackId: OWNER_ID,
        initialStatus: yield* lifecycle.currentStatus,
        application,
      });
      if (!isControlOwnership(owner)) throw new Error("expected control ownership");
      yield* lifecycle.setClose(owner.close);
      const status = supervisorStatus(yield* lifecycle.currentStatus);
      const layer = RemoteStack.layer(owner.endpoint, {
        cliVersion: "test",
        owner: {
          ownershipId: OWNER_ID,
          ownerSessionId: status.ownerSessionId,
          controlProtocolVersion: status.controlProtocolVersion,
          daemonCliVersion: status.daemonCliVersion,
        },
      }).pipe(Layer.provide(httpTransportClientLayer));

      const streamExit = yield* Effect.scoped(
        Effect.gen(function* () {
          const remote = yield* Stack;
          const active = yield* Effect.forkChild(Stream.runDrain(remote.allStateChanges), {
            startImmediately: true,
          });
          yield* Deferred.await(streamStarted);
          yield* lifecycle.disposeRuntime;
          const exit = yield* Fiber.await(active);
          yield* Deferred.succeed(releaseStop, undefined);
          yield* lifecycle.awaitShutdown.pipe(Effect.exit);
          return exit;
        }).pipe(Effect.provide(layer)),
      );

      expect(Exit.isFailure(streamExit)).toBe(true);
      if (Exit.isFailure(streamExit)) {
        const error = Cause.squash(streamExit.cause);
        expect(Predicate.isTagged(error, "StackUnavailableError")).toBe(true);
        if (Predicate.isTagged(error, "StackUnavailableError")) {
          expect(error).toMatchObject({
            phase: "failed",
            detail: "Local stack disposed unexpectedly",
          } satisfies Pick<StackUnavailableError, "phase" | "detail">);
        }
      }
    }).pipe(Effect.provide(controlTransportLayer)),
  ),
);

it.live("interrupts an in-flight runtime mutation before stopping the stack", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* makeSupervisorSessionFixture({
        ownershipId: OWNER_ID,
        ownerSessionId: "mutation-stop-session",
        daemonCliVersion: "test",
      });
      const operationLock = Semaphore.makeUnsafe(1);
      const mutationStarted = Deferred.makeUnsafe<void>();
      const mutationReleased = Deferred.makeUnsafe<void>();
      const stopStarted = Deferred.makeUnsafe<void>();
      yield* lifecycle.publishStack({
        ...stack,
        reloadEdgeRuntime: () =>
          Deferred.succeed(mutationStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(mutationReleased, undefined)),
            operationLock.withPermit,
          ),
        stop: Deferred.succeed(stopStarted, undefined).pipe(
          Effect.asVoid,
          operationLock.withPermit,
        ),
      });
      const application = {
        app: yield* makeSupervisorControlApplication(lifecycle),
      };
      const owner = yield* acquireControl({
        stackId: OWNER_ID,
        initialStatus: yield* lifecycle.currentStatus,
        application,
      });
      if (!isControlOwnership(owner)) throw new Error("expected control ownership");
      yield* lifecycle.setClose(owner.close);
      const status = supervisorStatus(yield* lifecycle.currentStatus);
      const layer = RemoteStack.layer(owner.endpoint, {
        cliVersion: "test",
        owner: {
          ownershipId: OWNER_ID,
          ownerSessionId: status.ownerSessionId,
          controlProtocolVersion: status.controlProtocolVersion,
          daemonCliVersion: status.daemonCliVersion,
        },
      }).pipe(Layer.provide(httpTransportClientLayer));
      const remote = yield* Layer.build(layer).pipe(
        Effect.map((context) => Context.get(context, Stack)),
      );

      const mutation = yield* remote
        .reloadEdgeRuntime({ edgeRuntime: { enabled: true } })
        .pipe(Effect.forkChild);
      yield* Deferred.await(mutationStarted);
      const response = yield* Effect.promise(() =>
        fetch(`${owner.endpoint.url}/stop`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownershipId: status.ownershipId,
            ownerSessionId: status.ownerSessionId,
            intent: "explicit",
          }),
        }),
      );

      expect(response.status).toBe(202);
      yield* Deferred.await(mutationReleased);
      yield* Deferred.await(stopStarted);
      expect(Exit.isFailure(yield* Fiber.await(mutation))).toBe(true);
      yield* lifecycle.awaitShutdown;
    }).pipe(Effect.provide(controlTransportLayer)),
  ),
);
