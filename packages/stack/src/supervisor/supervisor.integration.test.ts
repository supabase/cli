import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Queue,
  Redacted,
  Ref,
  Scope,
  Stream,
} from "effect";
import { Headers } from "effect/unstable/http";
import { Rpc } from "effect/unstable/rpc";
import { RequestId } from "effect/unstable/rpc/RpcMessage";
import type { LogOptions, StackLogEntry } from "../public/Logs.ts";
import type { CapabilityName } from "../public/Capability.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import {
  GatewayActivationError,
  PortUnavailableError,
  StackLifecycleConflictError,
  StackNotRunningError,
  StackReconciliationError,
  StackStateInvalidError,
  StackMustBeStoppedError,
} from "../public/Errors.ts";
import {
  RuntimeDriverError,
  type RuntimeDriver,
  type ObservedWorkload,
} from "../runtime/RuntimeDriver.ts";
import type { EffectStackCredentials } from "../public/Credentials.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import { deriveStackId } from "../identity/Identity.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { StackRpcGroup, type StackRpcError } from "../control/StackRpc.ts";
import { makeSupervisor, type Supervisor, type SupervisorRuntime } from "./Supervisor.ts";
import type { SupervisorIngress } from "./Ingress.ts";

const identity = {
  projectRoot: "/tmp/supabase-supervisor",
  checkoutRoot: "/tmp/supabase-supervisor",
  workspaceId: "/tmp/supabase-supervisor",
  checkoutId: "/tmp/supabase-supervisor",
  branchContext: "ordinary-workspace",
  localProjectKey: ".",
  stackName: "supervisor",
} as const;

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const invokeCredentials = (
  supervisor: Supervisor,
): Effect.Effect<EffectStackCredentials, StackRpcError, Scope.Scope> =>
  Effect.gen(function* () {
    const handler = yield* StackRpcGroup.accessHandler("credentials").pipe(
      Effect.provide(
        StackRpcGroup.toLayerHandler("credentials", supervisor.rpcHandlers.credentials),
      ),
    );
    const value = yield* handler(undefined, {
      client: new Rpc.ServerClient(1),
      requestId: RequestId(1),
      headers: Headers.empty,
    });
    if (Deferred.isDeferred<EffectStackCredentials, StackRpcError>(value))
      return yield* Deferred.await(value);
    return value;
  });

const invokePrepare = (
  supervisor: Supervisor,
  payload: {
    readonly config?: import("../public/Config.ts").StackConfig;
    readonly capabilities?: ReadonlyArray<CapabilityName>;
  } = {},
): Effect.Effect<
  {
    readonly capabilities: ReadonlyArray<{
      readonly capability: CapabilityName;
      readonly version: string;
      readonly outcome: "cached" | "downloaded" | "pulled";
    }>;
  },
  StackRpcError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const handler = yield* StackRpcGroup.accessHandler("prepare").pipe(
      Effect.provide(StackRpcGroup.toLayerHandler("prepare", supervisor.rpcHandlers.prepare)),
    );
    const value = yield* handler(payload, {
      client: new Rpc.ServerClient(1),
      requestId: RequestId(1),
      headers: Headers.empty,
    });
    if (
      Deferred.isDeferred<
        {
          readonly capabilities: ReadonlyArray<{
            readonly capability: CapabilityName;
            readonly version: string;
            readonly outcome: "cached" | "downloaded" | "pulled";
          }>;
        },
        StackRpcError
      >(value)
    )
      return yield* Deferred.await(value);
    return value;
  });

const makeFixture = (
  fixtureOptions: {
    readonly ingress?: SupervisorIngress;
    readonly timeline?: Ref.Ref<ReadonlyArray<string>>;
    readonly runtime?: StackRuntime;
    readonly prepareOutcome?: "cached" | "downloaded" | "pulled";
    readonly prepareGate?: Deferred.Deferred<void>;
    readonly prepareStarted?: Deferred.Deferred<void>;
    readonly startGate?: Deferred.Deferred<void>;
    readonly startStarted?: Deferred.Deferred<void>;
    readonly activationGate?: Deferred.Deferred<void>;
    readonly activationStarted?: Deferred.Deferred<void>;
    readonly activationCalls?: Ref.Ref<number>;
    readonly activationFailFirst?: Ref.Ref<boolean>;
    readonly startFailures?: Ref.Ref<number>;
    readonly preflightFailFirst?: Ref.Ref<boolean>;
    readonly preflightModes?: Ref.Ref<ReadonlyArray<"cold" | "live">>;
    readonly preflightGate?: Deferred.Deferred<void>;
    readonly preflightStarted?: Deferred.Deferred<void>;
    readonly stopGate?: Deferred.Deferred<void>;
    readonly stopStarted?: Deferred.Deferred<void>;
    readonly workloadStopFailFirst?: Ref.Ref<boolean>;
    readonly stopFailFirst?: Ref.Ref<boolean>;
    readonly destroyGate?: Deferred.Deferred<void>;
    readonly destroyStarted?: Deferred.Deferred<void>;
    readonly destroyPreFenceFail?: Ref.Ref<boolean>;
    readonly failureQueue?: Queue.Queue<ObservedWorkload>;
    readonly startQueue?: Queue.Queue<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-supervisor-" });
    const id = yield* deriveStackId(identity);
    const baseStore = yield* makeStackStateStore({ stateRoot: root });
    const destroyPreFenceFail = fixtureOptions.destroyPreFenceFail;
    const store =
      destroyPreFenceFail === undefined
        ? baseStore
        : {
            ...baseStore,
            replace: (stackId: string, state: Parameters<typeof baseStore.replace>[1]) =>
              Effect.gen(function* () {
                if (state.desiredLifecycle === "destroying") {
                  const fail = yield* Ref.get(destroyPreFenceFail);
                  if (fail) {
                    yield* Ref.set(destroyPreFenceFail, false);
                    return yield* new StackStateInvalidError({
                      message: "injected destroy fence failure",
                    });
                  }
                }
                return yield* baseStore.replace(stackId, state);
              }),
          };
    yield* store.initialize(id, {
      format: "supabase-stack-state-v1",
      identity: { ...identity, stackId: id },
      runtime: fixtureOptions.runtime ?? { kind: "native" },
      desiredLifecycle: "unconfigured",
      ports: [],
      privatePorts: [],
      secrets: {},
    });
    const resources = yield* Ref.make<ReadonlyArray<ObservedWorkload>>([]);
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const logOptions = yield* Ref.make<ReadonlyArray<LogOptions | undefined>>([]);
    const failDestroy = yield* Ref.make(false);
    let gateStopCleanup = false;
    const driver: RuntimeDriver = {
      watchFailures:
        fixtureOptions.failureQueue === undefined
          ? Stream.empty
          : Stream.fromQueue(fixtureOptions.failureQueue),
      observe: () => Ref.get(resources),
      start: (key, workload: PlannedWorkload) =>
        Effect.gen(function* () {
          gateStopCleanup = true;
          if (fixtureOptions.timeline !== undefined)
            yield* Ref.update(fixtureOptions.timeline, (current) => [
              ...current,
              `start:${workload.id}`,
            ]);
          yield* Ref.update(calls, (current) => [...current, `start:${workload.id}`]);
          if (fixtureOptions.startStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.startStarted, undefined);
          if (fixtureOptions.startGate !== undefined)
            yield* Deferred.await(fixtureOptions.startGate);
          if (
            fixtureOptions.startFailures !== undefined &&
            key.workloadId === "functions:edge-runtime"
          ) {
            const remaining = yield* Ref.get(fixtureOptions.startFailures);
            if (remaining > 0) {
              yield* Ref.set(fixtureOptions.startFailures, remaining - 1);
              const failed = { ...key, state: "failed" as const, error: "injected start failure" };
              yield* Ref.update(resources, (current) => [
                ...current.filter((entry) => entry.workloadId !== key.workloadId),
                failed,
              ]);
              return yield* new RuntimeDriverError({
                message: "injected start failure",
                stackId: key.stackId,
                workloadId: key.workloadId,
              });
            }
          }
          const ready = { ...key, state: "ready" as const };
          yield* Ref.update(resources, (current) => [
            ...current.filter((entry) => entry.workloadId !== key.workloadId),
            ready,
          ]);
          if (fixtureOptions.startQueue !== undefined)
            yield* Queue.offer(fixtureOptions.startQueue, workload.id);
          return ready;
        }),
      stop: (key) =>
        Effect.gen(function* () {
          if (fixtureOptions.workloadStopFailFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.workloadStopFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.workloadStopFailFirst, false);
              return yield* new RuntimeDriverError({
                message: "injected workload stop failure",
                stackId: key.stackId,
                workloadId: key.workloadId,
              });
            }
          }
          if (fixtureOptions.timeline !== undefined)
            yield* Ref.update(fixtureOptions.timeline, (current) => [
              ...current,
              `stop:${key.workloadId}`,
            ]);
          yield* Ref.update(resources, (current) =>
            current.filter((entry) => entry.workloadId !== key.workloadId),
          );
        }),
      remove: (key) =>
        Ref.update(resources, (current) =>
          current.filter((entry) => entry.workloadId !== key.workloadId),
        ),
      cleanup: ({ destroy }) =>
        Effect.gen(function* () {
          if (destroy && (yield* Ref.get(failDestroy)))
            return yield* new RuntimeDriverError({ message: "destroy failed" });
          if (!destroy && fixtureOptions.stopFailFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.stopFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.stopFailFirst, false);
              return yield* new RuntimeDriverError({ message: "injected stop cleanup failure" });
            }
          }
          if (fixtureOptions.timeline !== undefined)
            yield* Ref.update(fixtureOptions.timeline, (current) => [
              ...current,
              `cleanup:${destroy ? "destroy" : "stop"}`,
            ]);
          yield* Ref.update(calls, (current) => [
            ...current,
            `cleanup:${destroy ? "destroy" : "stop"}`,
          ]);
          if (destroy && fixtureOptions.destroyStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.destroyStarted, undefined);
          if (destroy && fixtureOptions.destroyGate !== undefined)
            yield* Deferred.await(fixtureOptions.destroyGate);
          if (!destroy && gateStopCleanup && fixtureOptions.stopStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.stopStarted, undefined);
          if (!destroy && gateStopCleanup && fixtureOptions.stopGate !== undefined)
            yield* Deferred.await(fixtureOptions.stopGate);
          yield* Ref.set(resources, []);
        }),
    };
    const entry: StackLogEntry = {
      cursor: { opaque: "v1_1" },
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "supervisor",
      stream: "internal",
      message: "hello",
    };
    const runtime: SupervisorRuntime = {
      driver,
      prepare: (_runtime, workloads) =>
        Effect.gen(function* () {
          if (fixtureOptions.prepareStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.prepareStarted, undefined);
          if (fixtureOptions.prepareGate !== undefined)
            yield* Deferred.await(fixtureOptions.prepareGate);
          return yield* Effect.forEach(workloads, (workload) =>
            Ref.update(calls, (current) => [...current, `prepare:${workload.id}`]).pipe(
              Effect.as({
                workloadId: workload.id,
                capability: workload.capability,
                version: "test",
                outcome: fixtureOptions.prepareOutcome ?? "cached",
              }),
            ),
          );
        }),
      preflight: (_input, mode) =>
        Effect.gen(function* () {
          if (fixtureOptions.preflightModes !== undefined)
            yield* Ref.update(fixtureOptions.preflightModes, (current) => [...current, mode]);
          if (fixtureOptions.preflightStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.preflightStarted, undefined);
          if (fixtureOptions.preflightGate !== undefined)
            yield* Deferred.await(fixtureOptions.preflightGate);
          if (fixtureOptions.preflightFailFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.preflightFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.preflightFailFirst, false);
              return yield* new StackReconciliationError({ message: "injected preflight failure" });
            }
          }
        }),
      activate: () =>
        Effect.gen(function* () {
          if (fixtureOptions.activationCalls !== undefined)
            yield* Ref.update(fixtureOptions.activationCalls, (count) => count + 1);
          if (fixtureOptions.activationStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.activationStarted, undefined);
          if (fixtureOptions.activationGate !== undefined)
            yield* Deferred.await(fixtureOptions.activationGate);
          if (fixtureOptions.activationFailFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.activationFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.activationFailFirst, false);
              return yield* new GatewayActivationError({ message: "injected activation failure" });
            }
          }
          return { host: "127.0.0.1", port: 9999 };
        }),
      ingress: fixtureOptions.ingress ?? {
        acquire: () =>
          Effect.succeed({
            assignments: {},
            privateAssignments: [],
            hostListeners: [],
            fresh: false,
          }),
        open: () => Effect.void,
        close: Effect.void,
      },
      logStore: {
        path: "memory://logs",
        append: () => Effect.succeed(entry),
        read: () => Effect.succeed([entry]),
        stream: (options) =>
          Stream.unwrap(
            Ref.update(logOptions, (current) => [...current, options]).pipe(
              Effect.map(() =>
                options?.follow === true
                  ? Stream.concat(Stream.succeed(entry), Stream.never)
                  : Stream.succeed(entry),
              ),
            ),
          ),
      },
    };
    const context = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | import("effect").Crypto.Crypto
    >();
    const supervisor = yield* makeSupervisor({
      identity,
      stackId: id,
      ownerSessionId: "owner-session",
      rpcRelease: "test-release",
      stateStore: store,
      context,
      runtime,
    });
    yield* Ref.set(calls, []);
    return { supervisor, calls, logOptions, failDestroy, context, store, id, runtime, resources };
  });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("Supervisor composition", () => {
  it.live("prepares a prospective config without mutating state or starting resources", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const before = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        const result = yield* invokePrepare(fixture.supervisor, {
          config: {
            capabilities: {
              rest: {},
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        expect(result.capabilities).toEqual([
          { capability: "database", version: expect.any(String), outcome: "cached" },
          { capability: "rest", version: expect.any(String), outcome: "cached" },
        ]);
        expect(yield* fixture.store.read(fixture.id)).toEqual(before);
        expect(yield* Ref.get(fixture.calls)).toEqual([
          "prepare:database:database",
          "prepare:rest:rest",
        ]);
      }),
    ),
  );

  it.live("keeps interrupted preparation owned until it completes, then shuts down", () =>
    run(
      Effect.gen(function* () {
        const prepareGate = yield* Deferred.make<void>();
        const prepareStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ prepareGate, prepareStarted });
        const preparing = yield* Effect.forkChild(invokePrepare(fixture.supervisor, {}), {
          startImmediately: true,
        });
        yield* Deferred.await(prepareStarted);
        const shutdown = yield* Effect.forkChild(fixture.supervisor.shutdown, {
          startImmediately: true,
        });
        yield* Fiber.interrupt(preparing);
        yield* fixture.supervisor.shutdownIfIdle;
        expect(shutdown.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(prepareGate, undefined);
        yield* Fiber.join(shutdown);
      }),
    ),
  );

  it.live("rejects new work after owner shutdown begins", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.shutdownIfIdle;

        const start = yield* fixture.supervisor.start().pipe(Effect.exit);
        const prepare = yield* invokePrepare(fixture.supervisor).pipe(Effect.exit);

        expect(errorOf(start)).toBeInstanceOf(StackLifecycleConflictError);
        expect(errorOf(prepare)?.tag).toBe("StackLifecycleConflictError");
      }),
    ),
  );

  it.live("prepares persisted pins and includes dependency closure in start order", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: {},
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        yield* Ref.set(fixture.calls, []);
        const result = yield* invokePrepare(fixture.supervisor, { capabilities: ["rest", "rest"] });
        expect(result.capabilities.map(({ capability }) => capability)).toEqual([
          "database",
          "rest",
        ]);
        expect(yield* Ref.get(fixture.calls)).toEqual([
          "prepare:database:database",
          "prepare:rest:rest",
        ]);
      }),
    ),
  );

  it.live("reports a native capability as downloaded when any workload was downloaded", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ prepareOutcome: "downloaded" });
        const result = yield* invokePrepare(fixture.supervisor, {
          config: {
            capabilities: {
              rest: {},
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        expect(result.capabilities).toEqual([
          { capability: "database", version: expect.any(String), outcome: "downloaded" },
          { capability: "rest", version: expect.any(String), outcome: "downloaded" },
        ]);
      }),
    ),
  );

  it.live("reports cached and pulled container preparation outcomes", () =>
    run(
      Effect.gen(function* () {
        const config = {
          capabilities: {
            rest: {},
            auth: { enabled: false },
            realtime: { enabled: false },
            storage: { enabled: false },
            functions: { enabled: false },
            studio: { enabled: false },
            mail: { enabled: false },
            analytics: { enabled: false },
            pooler: { enabled: false },
          },
        };
        const present = yield* makeFixture({
          runtime: { kind: "container", engine: "docker" },
          prepareOutcome: "cached",
        });
        const presentResult = yield* invokePrepare(present.supervisor, { config });
        expect(presentResult.capabilities.every(({ outcome }) => outcome === "cached")).toBe(true);

        const pulled = yield* makeFixture({
          runtime: { kind: "container", engine: "docker" },
          prepareOutcome: "pulled",
        });
        const pulledResult = yield* invokePrepare(pulled.supervisor, { config });
        expect(pulledResult.capabilities).toEqual([
          { capability: "database", version: expect.any(String), outcome: "pulled" },
          { capability: "rest", version: expect.any(String), outcome: "pulled" },
        ]);
      }),
    ),
  );

  it.live("rejects a request for a disabled capability before preparing anything", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const failed = yield* invokePrepare(fixture.supervisor, {
          config: {
            capabilities: {
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
          capabilities: ["auth"],
        }).pipe(Effect.exit);
        expect(errorOf(failed)?.tag).toBe("StackPreparationError");
        expect(yield* Ref.get(fixture.calls)).toEqual([]);
      }),
    ),
  );

  it.live("starts through the composed lifecycle and reports observed readiness", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        expect((yield* fixture.supervisor.status).lifecycle).toBe("unconfigured");
        const status = yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
        expect(status.lifecycle).toBe("running");
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
        expect(yield* Ref.get(fixture.calls)).toContain("start:database:database");
      }),
    ),
  );

  it.live("keeps post-commit startup failure observable as starting", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Effect.fail(
                new PortUnavailableError({
                  field: "api",
                  port: 54_321,
                  message: "injected ingress failure",
                }),
              ),
            open: () => Effect.void,
            close: Effect.void,
          },
        });
        expect(
          Exit.isFailure(yield* fixture.supervisor.start({ config: {} }).pipe(Effect.exit)),
        ).toBe(true);
        const status = yield* fixture.supervisor.status;
        expect(status.desiredLifecycle).toBe("running");
        expect(status.lifecycle).toBe("starting");
      }),
    ),
  );

  it.live("keeps post-commit restart failure observable as starting", () =>
    run(
      Effect.gen(function* () {
        const acquireCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Ref.updateAndGet(acquireCalls, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count !== 2
                    ? Effect.succeed({
                        assignments: {},
                        privateAssignments: [],
                        hostListeners: [],
                        fresh: true,
                      })
                    : Effect.fail(
                        new PortUnavailableError({
                          field: "api",
                          port: 54_321,
                          message: "injected restart ingress failure",
                        }),
                      ),
                ),
              ),
            open: () => Effect.void,
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({ config: {} });

        expect(Exit.isFailure(yield* fixture.supervisor.restart().pipe(Effect.exit))).toBe(true);
        const status = yield* fixture.supervisor.status;
        expect(status.desiredLifecycle).toBe("running");
        expect(status.lifecycle).toBe("starting");
        expect(errorOf(yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit))?.tag).toBe(
          "StackNotRunningError",
        );
        const recovered = yield* fixture.supervisor.start();
        expect(recovered.lifecycle).toBe("running");
        expect(recovered.capabilities.find(({ name }) => name === "database")?.state).toBe("ready");
        expect(yield* Ref.get(fixture.calls)).toContain("start:database:database");
      }),
    ),
  );

  it.live("recovers a stopped live owner after fresh ingress acquisition fails", () =>
    run(
      Effect.gen(function* () {
        const acquireCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Ref.updateAndGet(acquireCalls, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count !== 2
                    ? Effect.succeed({
                        assignments: {},
                        privateAssignments: [],
                        hostListeners: [],
                        fresh: true,
                      })
                    : Effect.fail(
                        new PortUnavailableError({
                          field: "api",
                          port: 54_321,
                          message: "injected stopped-owner ingress failure",
                        }),
                      ),
                ),
              ),
            open: () => Effect.void,
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({ config: {} });
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);

        expect(Exit.isFailure(yield* fixture.supervisor.start().pipe(Effect.exit))).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("starting");
        const recovered = yield* fixture.supervisor.start();
        expect(recovered.lifecycle).toBe("running");
        expect(recovered.capabilities.find(({ name }) => name === "database")?.state).toBe("ready");
      }),
    ),
  );

  it.live("starts only database by default and keeps other capabilities dormant", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const status = yield* fixture.supervisor.start({ config: {} });
        expect(status.lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.calls)).toEqual(["cleanup:stop", "start:database:database"]);
        expect(status.capabilities.find(({ name }) => name === "database")?.state).toBe("ready");
        for (const name of [
          "rest",
          "auth",
          "realtime",
          "storage",
          "functions",
          "studio",
          "mail",
          "analytics",
          "pooler",
        ] as const)
          expect(status.capabilities.find((capability) => capability.name === name)?.state).toBe(
            "dormant",
          );
      }),
    ),
  );

  it.live("cleans stale runtime resources before the first start of a new supervisor", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: {} });
        yield* Ref.set(fixture.calls, []);
        yield* Ref.set(fixture.resources, [
          {
            stackId: fixture.id,
            workloadId: "database:database",
            specHash: "stale",
            state: "ready",
          },
        ]);

        const successor = yield* makeSupervisor({
          identity,
          stackId: fixture.id,
          ownerSessionId: "successor-session",
          rpcRelease: "test-release",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        yield* successor.start();
        expect(yield* Ref.get(fixture.calls)).toEqual(["cleanup:stop", "start:database:database"]);

        yield* Ref.set(fixture.calls, []);
        yield* successor.start();
        expect(yield* Ref.get(fixture.calls)).toEqual([]);
      }),
    ),
  );

  it.live("uses cold preflight only when a fresh Supervisor performs restart", () =>
    run(
      Effect.gen(function* () {
        const preflightModes = yield* Ref.make<ReadonlyArray<"cold" | "live">>([]);
        const fixture = yield* makeFixture({ preflightModes });
        yield* fixture.supervisor.start({ config: {} });
        yield* Ref.set(preflightModes, []);

        yield* fixture.supervisor.restart();
        expect(yield* Ref.get(preflightModes)).toEqual(["live"]);

        const successor = yield* makeSupervisor({
          identity,
          stackId: fixture.id,
          ownerSessionId: "successor-session",
          rpcRelease: "test-release",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        yield* Ref.set(preflightModes, []);
        yield* successor.restart();
        expect(yield* Ref.get(preflightModes)).toEqual(["cold"]);
      }),
    ),
  );

  it.live("keeps first-start cleanup retryable when cleanup fails", () =>
    run(
      Effect.gen(function* () {
        const stopFailFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({ stopFailFirst });
        const failed = yield* fixture.supervisor.start({ config: {} }).pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("unconfigured");
        expect(yield* Ref.get(fixture.calls)).toEqual([]);

        const status = yield* fixture.supervisor.start({ config: {} });
        expect(status.lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.calls)).toEqual(["cleanup:stop", "start:database:database"]);
      }),
    ),
  );

  it.live("returns persisted database, API, and storage credentials while running", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined || running.definition === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        yield* fixture.store
          .replace(fixture.id, {
            ...running,
            ports: [
              { field: "api", port: 55433, intent: "exact" },
              { field: "database", port: 55432, intent: "exact" },
            ] as const,
          })
          .pipe(Effect.provideContext(fixture.context));
        const credentials = yield* invokeCredentials(fixture.supervisor);
        expect(credentials.database.url).toEqual(expect.anything());
        expect(Redacted.value(credentials.database.url)).toMatch(
          /^postgresql:\/\/postgres:.+@127\.0\.0\.1:\d+\/postgres$/,
        );
        expect(Redacted.value(credentials.database.password)).toEqual(expect.any(String));
        expect(credentials.api.publishableKey).toEqual(expect.any(String));
        expect(Redacted.value(credentials.api.secretKey)).toEqual(expect.any(String));
        expect(credentials.api.anonJwt).toEqual(expect.any(String));
        expect(Redacted.value(credentials.api.serviceRoleJwt)).toEqual(expect.any(String));
        expect(credentials.storage).toEqual(
          expect.objectContaining({
            region: "local",
            accessKeyId: "625729a08b95bf1b7ff351a663f3a23c",
          }),
        );
        if (credentials.storage === undefined)
          return yield* new StackStateInvalidError({ message: "storage credentials are missing" });
        const persistedStorageSecret =
          running.secrets["secret:storage.settings.s3_protocol.secret_access_key"]?.value;
        expect(persistedStorageSecret).toEqual(expect.any(String));
        expect(Redacted.value(credentials.storage.secretAccessKey)).toBe(persistedStorageSecret);
      }),
    ),
  );

  it.live("URL-encodes persisted database credentials and brackets IPv6 listeners", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined || running.definition === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        const definition = {
          ...running.definition,
          listeners: {
            ...running.definition.listeners,
            database: { ...running.definition.listeners.database, address: "2001:db8::1" },
          },
        };
        const state = {
          ...running,
          definition,
          ports: [
            { field: "api", port: 55433, intent: "exact" as const },
            { field: "database", port: 55432, intent: "exact" as const },
          ] as const,
          secrets: {
            ...running.secrets,
            "secret:database.internal.password": {
              policy: "managed" as const,
              value: "p@ss:word",
            },
          },
        };
        yield* fixture.store
          .replace(fixture.id, state)
          .pipe(Effect.provideContext(fixture.context));
        const credentials = yield* invokeCredentials(fixture.supervisor);
        expect(Redacted.value(credentials.database.url)).toBe(
          "postgresql://postgres:p%40ss%3Aword@[2001:db8::1]:55432/postgres",
        );
      }),
    ),
  );

  it.live("omits storage credentials when Storage is disabled", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: {}, storage: { enabled: false } } },
        });
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        const state = {
          ...running,
          ports: [
            { field: "api", port: 55433, intent: "exact" as const },
            { field: "database", port: 55432, intent: "exact" as const },
          ] as const,
        };
        yield* fixture.store
          .replace(fixture.id, state)
          .pipe(Effect.provideContext(fixture.context));
        const credentials = yield* invokeCredentials(fixture.supervisor);
        expect(credentials.storage).toBeUndefined();
      }),
    ),
  );

  it.live("fails closed when Auth is disabled or a required secret slot is absent", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: {}, auth: { enabled: false } } },
        });
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        const state = {
          ...running,
          ports: [
            { field: "api", port: 55433, intent: "exact" as const },
            { field: "database", port: 55432, intent: "exact" as const },
          ] as const,
        };
        yield* fixture.store
          .replace(fixture.id, state)
          .pipe(Effect.provideContext(fixture.context));
        const authDisabled = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(authDisabled)).toEqual(
          expect.objectContaining({ tag: "StackNotRunningError" }),
        );
        if (state.definition === undefined)
          return yield* new StackStateInvalidError({ message: "running definition is missing" });
        const baseSecrets = {
          ...state.secrets,
          "secret:auth.settings.publishable_key": {
            policy: "managed" as const,
            value: "publishable",
          },
          "secret:auth.settings.secret_key": { policy: "managed" as const, value: "secret" },
          "secret:auth.settings.anon_key": { policy: "managed" as const, value: "anon" },
          "secret:auth.settings.service_role_key": { policy: "managed" as const, value: "service" },
        };
        const missingSecret = {
          ...state,
          definition: {
            ...state.definition,
            capabilities: {
              ...state.definition.capabilities,
              auth: { ...state.definition.capabilities.auth, enabled: true },
            },
          },
          secrets: Object.fromEntries(
            Object.entries(baseSecrets).filter(
              ([slot]) => slot !== "secret:auth.settings.publishable_key",
            ),
          ),
        };
        const missingExit = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(missingExit)).toEqual(
          expect.objectContaining({ tag: "StackNotRunningError" }),
        );
        const storageSecretMissing = {
          ...missingSecret,
          secrets: Object.fromEntries(
            Object.entries(baseSecrets).filter(
              ([slot]) => slot !== "secret:storage.settings.s3_protocol.secret_access_key",
            ),
          ),
        };
        yield* fixture.store
          .replace(fixture.id, storageSecretMissing)
          .pipe(Effect.provideContext(fixture.context));
        const storageExit = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(storageExit)).toEqual(
          expect.objectContaining({ tag: "StackSecretMismatchError" }),
        );
        const complete = { ...missingSecret, secrets: baseSecrets };
        const missingApiListener = {
          ...complete,
          ports: [{ field: "database", port: 55432, intent: "exact" as const }] as const,
        };
        yield* fixture.store
          .replace(fixture.id, missingApiListener)
          .pipe(Effect.provideContext(fixture.context));
        const listenerExit = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(listenerExit)).toEqual(
          expect.objectContaining({ tag: "StackNotRunningError" }),
        );
      }),
    ),
  );

  it.live("acknowledges stop only after runtime cleanup", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const response = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(response.ok).toBe(true);
        expect(yield* Ref.get(fixture.calls)).toContain("cleanup:stop");
      }),
    ),
  );

  it.live("publishes stopping while stop cleanup is still in progress", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });

        const subscribed = yield* Deferred.make<void>();
        const stopping = yield* Deferred.make<void>();
        const watcher = yield* Effect.forkChild(
          Stream.runForEach(fixture.supervisor.watchStatus, (status) =>
            Effect.gen(function* () {
              if (!(yield* Deferred.isDone(subscribed)))
                yield* Deferred.succeed(subscribed, undefined);
              if (status.lifecycle === "stopping") yield* Deferred.succeed(stopping, undefined);
            }),
          ),
        );
        yield* fixture.supervisor.start();
        yield* Deferred.await(subscribed);

        const stop = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.await(stopStarted);
        yield* Deferred.await(stopping);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");

        yield* Deferred.succeed(stopGate, undefined);
        expect((yield* Fiber.join(stop)).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
        yield* Fiber.interrupt(watcher);
      }),
    ),
  );

  it.live("preserves stop cleanup diagnostics through maintenance responses", () =>
    run(
      Effect.gen(function* () {
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ stopFailFirst });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Ref.set(stopFailFirst, true);

        const response = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(response).toEqual({
          ok: false,
          error: { tag: "operation-failed", message: "injected stop cleanup failure" },
        });
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
      }),
    ),
  );

  it.live("keeps restart in starting state across its internal stop leg", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });

        const subscribed = yield* Deferred.make<void>();
        const observed = yield* Ref.make<ReadonlyArray<string>>([]);
        const watcher = yield* Effect.forkChild(
          Stream.runForEach(fixture.supervisor.watchStatus, (status) =>
            Effect.gen(function* () {
              yield* Ref.update(observed, (current) => [...current, status.lifecycle]);
              if (!(yield* Deferred.isDone(subscribed)))
                yield* Deferred.succeed(subscribed, undefined);
            }),
          ),
        );
        yield* fixture.supervisor.start();
        yield* Deferred.await(subscribed);

        const restarting = yield* Effect.forkChild(fixture.supervisor.restart());
        yield* Deferred.await(stopStarted);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("starting");
        yield* Deferred.succeed(stopGate, undefined);
        yield* Fiber.join(restarting);
        const lifecycles = yield* Ref.get(observed);
        expect(lifecycles).not.toContain("stopped");
        expect(lifecycles.at(-1)).toBe("running");
        yield* Fiber.interrupt(watcher);
      }),
    ),
  );

  it.live("publishes destroying while persistent data cleanup is in progress", () =>
    run(
      Effect.gen(function* () {
        const destroyGate = yield* Deferred.make<void>();
        const destroyStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ destroyGate, destroyStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });

        const subscribed = yield* Deferred.make<void>();
        const destroying = yield* Deferred.make<void>();
        const watcher = yield* Effect.forkChild(
          Stream.runForEach(fixture.supervisor.watchStatus, (status) =>
            Effect.gen(function* () {
              if (!(yield* Deferred.isDone(subscribed)))
                yield* Deferred.succeed(subscribed, undefined);
              if (status.lifecycle === "destroying") yield* Deferred.succeed(destroying, undefined);
            }),
          ),
        );
        yield* fixture.supervisor.start();
        yield* Deferred.await(subscribed);

        const destroy = yield* Effect.forkChild(fixture.supervisor.destroy);
        yield* Deferred.await(destroyStarted);
        yield* Deferred.await(destroying);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("destroying");

        yield* Deferred.succeed(destroyGate, undefined);
        yield* Fiber.join(destroy);
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
        yield* Fiber.interrupt(watcher);
      }),
    ),
  );

  it.live("passes log options through the Supervisor log stream", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const options: LogOptions = { follow: false, capabilities: ["auth"] };
        expect(yield* Stream.runCollect(fixture.supervisor.logs(options))).toHaveLength(1);
        expect(yield* Ref.get(fixture.logOptions)).toEqual([options]);
      }),
    ),
  );

  it.live("completes subscribed status streams after a clean stop", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const stopped = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const watcher = yield* Effect.forkChild(
          Stream.runForEach(fixture.supervisor.watchStatus, (status) =>
            status.lifecycle === "stopped" ? Deferred.succeed(stopped, undefined) : Effect.void,
          ).pipe(Effect.ensuring(Deferred.succeed(completed, undefined))),
        );
        const response = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(response.ok).toBe(true);
        yield* Deferred.await(stopped);
        yield* fixture.supervisor.shutdownIfIdle;
        yield* Deferred.await(completed);
        yield* Fiber.join(watcher);
      }),
    ),
  );

  it.live("completes followed logs after a clean stop", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const completed = yield* Deferred.make<void>();
        const watcher = yield* Effect.forkChild(
          Stream.runCollect(fixture.supervisor.logs({ follow: true })).pipe(
            Effect.tap((entries) => Effect.sync(() => expect(entries).toHaveLength(1))),
            Effect.ensuring(Deferred.succeed(completed, undefined)),
          ),
        );
        const response = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(response.ok).toBe(true);
        yield* fixture.supervisor.shutdownIfIdle;
        yield* Deferred.await(completed);
        yield* Fiber.join(watcher);
      }),
    ),
  );

  it.live("keeps running state and explicit restart guidance for changed start input", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const failed = yield* fixture.supervisor
          .start({ config: { capabilities: { rest: { settings: { schemas: ["private"] } } } } })
          .pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(StackMustBeStoppedError);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("running");
      }),
    ),
  );

  it.live("rejects restart while stopped without relaunching resources", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* fixture.supervisor.maintenanceHandlers.stop;
        const failed = yield* fixture.supervisor.restart().pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(StackNotRunningError);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("keeps the owner when restart cannot prove its stopped cleanup", () =>
    run(
      Effect.gen(function* () {
        const workloadStopFailFirst = yield* Ref.make(false);
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ workloadStopFailFirst, stopFailFirst });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Ref.set(workloadStopFailFirst, true);
        yield* Ref.set(stopFailFirst, true);

        const restarted = yield* fixture.supervisor.restart().pipe(Effect.exit);
        expect(errorOf(restarted)).toBeInstanceOf(StackReconciliationError);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");

        const shutdown = yield* Effect.forkChild(fixture.supervisor.shutdown, {
          startImmediately: true,
        });
        yield* fixture.supervisor.shutdownIfIdle;
        expect(shutdown.pollUnsafe()).toBeUndefined();

        const stopped = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(stopped.ok).toBe(true);
        yield* fixture.supervisor.shutdownIfIdle;
        yield* Fiber.join(shutdown);
        expect(yield* Ref.get(fixture.resources)).toEqual([]);
      }),
    ),
  );

  it.live("retries unproven stopped cleanup before starting again", () =>
    run(
      Effect.gen(function* () {
        const workloadStopFailFirst = yield* Ref.make(false);
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ workloadStopFailFirst, stopFailFirst });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Ref.set(workloadStopFailFirst, true);
        yield* Ref.set(stopFailFirst, true);
        yield* fixture.supervisor.restart().pipe(Effect.exit);
        yield* Ref.set(fixture.calls, []);

        const started = yield* fixture.supervisor.start();

        expect(started.lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.calls)).toEqual(["cleanup:stop", "start:database:database"]);
      }),
    ),
  );

  it.live("keeps lazy capabilities dormant until explicit activation", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const status = yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { enabled: false },
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { activation: "lazy" },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        expect(status.capabilities.find(({ name }) => name === "functions")?.state).toBe("dormant");
        expect(yield* Ref.get(fixture.calls)).toEqual(["cleanup:stop", "start:database:database"]);
        const activation = yield* fixture.supervisor.activate("functions");
        expect(activation.endpoint).toEqual({ host: "127.0.0.1", port: 9999 });
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "functions")
            ?.state,
        ).toBe("ready");
      }),
    ),
  );

  it.live("keeps accepted start work alive when its waiter is interrupted", () =>
    run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ startGate: gate, startStarted: started });
        const config = {
          capabilities: { rest: { activation: "eager" } },
        } satisfies import("../public/Config.ts").StackConfig;
        const waiter = yield* Effect.forkChild(fixture.supervisor.start({ config }));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(gate, undefined);
        const status = yield* fixture.supervisor.start({ config });
        expect(status.lifecycle).toBe("running");
        const starts = (yield* Ref.get(fixture.calls)).filter((call) => call.startsWith("start:"));
        expect(starts).toContain("start:database:database");
        expect(starts).toContain("start:rest:rest");
      }),
    ),
  );

  it.live("shuts down after an interrupted pre-commit start later fails", () =>
    run(
      Effect.gen(function* () {
        const preflightFailFirst = yield* Ref.make(true);
        const preflightGate = yield* Deferred.make<void>();
        const preflightStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          preflightFailFirst,
          preflightGate,
          preflightStarted,
        });
        const waiter = yield* Effect.forkChild(fixture.supervisor.start({ config: {} }));
        yield* Deferred.await(preflightStarted);
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(preflightGate, undefined);
        yield* fixture.supervisor.shutdown.pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.die("idle Supervisor did not shut down"),
          }),
        );
      }),
    ),
  );

  it.live("joins concurrent compiler-equivalent starts", () =>
    run(
      Effect.gen(function* () {
        const preflightFailFirst = yield* Ref.make(true);
        const preflightGate = yield* Deferred.make<void>();
        const preflightStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          preflightFailFirst,
          preflightGate,
          preflightStarted,
        });
        const firstConfig = {};
        const equivalentConfig = { capabilities: {} };
        const first = yield* Effect.forkChild(fixture.supervisor.start({ config: firstConfig }));
        yield* Deferred.await(preflightStarted);
        const second = yield* Effect.forkChild(
          fixture.supervisor.start({ config: equivalentConfig }),
        );
        yield* Deferred.succeed(preflightGate, undefined);
        const [firstExit, secondExit] = yield* Effect.all([
          Fiber.join(first).pipe(Effect.exit),
          Fiber.join(second).pipe(Effect.exit),
        ]);
        expect(Exit.isFailure(firstExit)).toBe(true);
        expect(Exit.isFailure(secondExit)).toBe(true);
        expect(yield* Ref.get(preflightFailFirst)).toBe(false);
      }),
    ),
  );

  it.live("does not join concurrent starts with distinct secret values", () =>
    run(
      Effect.gen(function* () {
        const preflightFailFirst = yield* Ref.make(true);
        const preflightGate = yield* Deferred.make<void>();
        const preflightStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({
          preflightFailFirst,
          preflightGate,
          preflightStarted,
        });
        const firstConfig = {
          security: {
            jwt: { signing: { kind: "symmetric" as const, secret: Redacted.make("a") } },
          },
        };
        const distinctConfig = {
          security: {
            jwt: { signing: { kind: "symmetric" as const, secret: Redacted.make("b") } },
          },
        };
        const first = yield* Effect.forkChild(fixture.supervisor.start({ config: firstConfig }));
        yield* Deferred.await(preflightStarted);
        const second = yield* Effect.forkChild(
          fixture.supervisor.start({ config: distinctConfig }),
        );
        yield* Deferred.succeed(preflightGate, undefined);
        const [firstExit, secondExit] = yield* Effect.all([
          Fiber.join(first).pipe(Effect.exit),
          Fiber.join(second).pipe(Effect.exit),
        ]);
        expect(Exit.isFailure(firstExit)).toBe(true);
        expect(errorOf(secondExit)).toBeInstanceOf(StackLifecycleConflictError);
      }),
    ),
  );

  it.live("single-flights lazy activation and retains its endpoint", () =>
    run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const activationCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          activationGate: gate,
          activationStarted: started,
          activationCalls,
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              rest: { enabled: false },
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { activation: "lazy" },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        const first = yield* Effect.forkChild(fixture.supervisor.activate("functions"));
        yield* Deferred.await(started);
        const second = yield* Effect.forkChild(fixture.supervisor.activate("functions"));
        yield* Deferred.succeed(gate, undefined);
        const [left, right] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
        expect(left).toEqual(right);
        expect(yield* Ref.get(activationCalls)).toBe(1);
        expect(yield* fixture.supervisor.activate("functions")).toEqual(left);
        expect(yield* Ref.get(activationCalls)).toBe(1);
      }),
    ),
  );

  it.live("keeps activated lazy workloads ready across an idempotent start", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const config = {
          capabilities: {
            rest: { enabled: false },
            auth: { enabled: false },
            realtime: { enabled: false },
            storage: { enabled: false },
            functions: { activation: "lazy" as const },
            studio: { enabled: false },
            mail: { enabled: false },
            analytics: { enabled: false },
            pooler: { enabled: false },
          },
        };
        yield* fixture.supervisor.start({ config });
        yield* fixture.supervisor.activate("functions");
        yield* Ref.set(fixture.calls, []);

        const status = yield* fixture.supervisor.start({ config });

        expect(yield* Ref.get(fixture.calls)).toEqual([]);
        expect(status.lifecycle).toBe("running");
        expect(status.capabilities.find(({ name }) => name === "functions")?.state).toBe("ready");
      }),
    ),
  );

  it.live("restarts a failed eager workload without removing an active lazy workload", () =>
    run(
      Effect.gen(function* () {
        const failures = yield* Queue.unbounded<ObservedWorkload>();
        const starts = yield* Queue.unbounded<string>();
        const fixture = yield* makeFixture({ failureQueue: failures, startQueue: starts });
        yield* fixture.supervisor.start({ config: { capabilities: { functions: {} } } });
        expect(yield* Queue.take(starts)).toBe("database:database");
        yield* fixture.supervisor.activate("functions");
        expect(yield* Queue.take(starts)).toBe("functions:edge-runtime");
        yield* Ref.set(fixture.calls, []);
        const database = (yield* Ref.get(fixture.resources)).find(
          ({ workloadId }) => workloadId === "database:database",
        );
        if (database === undefined) return yield* Effect.die("database did not start");
        yield* Ref.update(fixture.resources, (current) =>
          current.map((entry) =>
            entry.workloadId === database.workloadId
              ? { ...entry, state: "failed" as const, error: "crashed" }
              : entry,
          ),
        );

        yield* Queue.offer(failures, { ...database, state: "failed", error: "crashed" });
        expect(yield* Queue.take(starts)).toBe("database:database");

        const resources = yield* Ref.get(fixture.resources);
        expect(
          resources.find(({ workloadId }) => workloadId === "functions:edge-runtime")?.state,
        ).toBe("ready");
        expect(yield* Ref.get(fixture.calls)).not.toContain("stop:functions:edge-runtime");
      }),
    ),
  );

  it.live("restarts a ready workload after an owner-scoped runtime failure", () =>
    run(
      Effect.gen(function* () {
        const failures = yield* Queue.unbounded<ObservedWorkload>();
        const starts = yield* Queue.unbounded<string>();
        const fixture = yield* makeFixture({ failureQueue: failures, startQueue: starts });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Queue.take(starts);
        const ready = (yield* Ref.get(fixture.resources)).find(
          (entry) => entry.workloadId === "database:database",
        );
        if (ready === undefined) return yield* Effect.die("database did not start");
        yield* Ref.update(fixture.resources, (current) =>
          current.map((entry) =>
            entry.workloadId === ready.workloadId ? { ...entry, state: "failed" as const } : entry,
          ),
        );
        yield* Queue.offer(failures, { ...ready, state: "failed", error: "crashed" });
        expect(yield* Queue.take(starts)).toBe("database:database");
        expect(
          (yield* Ref.get(fixture.resources)).find(
            (entry) => entry.workloadId === "database:database",
          )?.state,
        ).toBe("ready");
      }),
    ),
  );

  it.live("keeps a post-readiness crash budget exhausted and visible in status", () =>
    run(
      Effect.gen(function* () {
        const failures = yield* Queue.unbounded<ObservedWorkload>();
        const starts = yield* Queue.unbounded<string>();
        const failedStatus = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ failureQueue: failures, startQueue: starts });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const initialWorkload = yield* Queue.take(starts);
        const ready = (yield* Ref.get(fixture.resources)).find(
          (entry) => entry.workloadId === initialWorkload,
        );
        if (ready === undefined) return yield* Effect.die("workload did not start");
        const watcher = yield* Effect.forkChild(
          Stream.runForEach(fixture.supervisor.watchStatus, (status) =>
            Effect.gen(function* () {
              const capability = status.capabilities.find(({ name }) => name === "database");
              if (capability?.state === "failed" && capability.error !== undefined)
                yield* Deferred.succeed(failedStatus, undefined);
            }),
          ),
        );

        // The catalog default allows five post-ready attempts; the sixth crash is terminal.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          yield* Ref.update(fixture.resources, (current) =>
            current.map((entry) =>
              entry.workloadId === ready.workloadId
                ? { ...entry, state: "failed" as const, error: "crashed" }
                : entry,
            ),
          );
          yield* Queue.offer(failures, { ...ready, state: "failed", error: "crashed" });
          yield* Queue.take(starts);
        }
        yield* Ref.update(fixture.resources, (current) =>
          current.map((entry) =>
            entry.workloadId === ready.workloadId
              ? { ...entry, state: "failed" as const, error: "crashed" }
              : entry,
          ),
        );
        yield* Queue.offer(failures, { ...ready, state: "failed", error: "crashed" });
        yield* Deferred.await(failedStatus);
        const status = yield* fixture.supervisor.status;
        const capability = status.capabilities.find(({ name }) => name === "database");
        expect(capability?.state).toBe("failed");
        expect(capability?.error).toContain("crashed");
        yield* Fiber.interrupt(watcher);
      }),
    ),
  );

  it.live("allows a failed activation to retry", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(true);
        const activationCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({ activationFailFirst, activationCalls });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        const retry = yield* fixture.supervisor.activate("functions");
        expect(retry.endpoint).toEqual({ host: "127.0.0.1", port: 9999 });
        expect(yield* Ref.get(activationCalls)).toBe(2);
      }),
    ),
  );

  it.live("reports a failed lazy activation as failed instead of dormant", () =>
    run(
      Effect.gen(function* () {
        const startFailures = yield* Ref.make(5);
        const fixture = yield* makeFixture({ startFailures });
        yield* fixture.supervisor.start({ config: { capabilities: { functions: {} } } });

        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);

        expect(Exit.isFailure(failed)).toBe(true);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "functions")
            ?.state,
        ).toBe("failed");
      }),
    ),
  );

  it.live("rejects activation while an explicit lifecycle transition is active", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: {}, functions: { activation: "lazy" } } },
        });

        const stopping = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.await(stopStarted);
        const activation = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);
        expect(errorOf(activation)).toBeInstanceOf(StackLifecycleConflictError);

        yield* Deferred.succeed(stopGate, undefined);
        yield* Fiber.join(stopping);
      }),
    ),
  );

  it.live("fences activation against a concurrent stop", () =>
    run(
      Effect.gen(function* () {
        const activationGate = yield* Deferred.make<void>();
        const activationStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ activationGate, activationStarted });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const activation = yield* Effect.forkChild(fixture.supervisor.activate("functions"));
        yield* Deferred.await(activationStarted);
        const stop = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.succeed(activationGate, undefined);
        yield* Fiber.join(activation);
        yield* Fiber.join(stop);
        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("stopped");
        expect(status.capabilities.find(({ name }) => name === "functions")?.state).toBe("stopped");
      }),
    ),
  );

  it.live("completes accepted stop after its waiter is interrupted", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const waiter = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.await(stopStarted);
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(stopGate, undefined);
        yield* fixture.supervisor.shutdown;
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("completes accepted destroy after its waiter is interrupted", () =>
    run(
      Effect.gen(function* () {
        const destroyGate = yield* Deferred.make<void>();
        const destroyStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ destroyGate, destroyStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const waiter = yield* Effect.forkChild(fixture.supervisor.destroy);
        yield* Deferred.await(destroyStarted);
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(destroyGate, undefined);
        yield* fixture.supervisor.shutdown;
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );
});
