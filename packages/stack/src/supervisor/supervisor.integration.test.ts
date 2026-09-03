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
import type { LogQuery, StackLogEntry } from "../public/Logs.ts";
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
    readonly startFinished?: Deferred.Deferred<void>;
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
    readonly workloadRemoveFailFirst?: Ref.Ref<boolean>;
    readonly stopFailFirst?: Ref.Ref<boolean>;
    readonly destroyGate?: Deferred.Deferred<void>;
    readonly destroyStarted?: Deferred.Deferred<void>;
    readonly destroyPreFenceFail?: Ref.Ref<boolean>;
    readonly stoppedReplaceFail?: Ref.Ref<boolean>;
    readonly startQueue?: Queue.Queue<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-supervisor-" });
    const id = yield* deriveStackId(identity);
    const baseStore = yield* makeStackStateStore({ stateRoot: root });
    const destroyPreFenceFail = fixtureOptions.destroyPreFenceFail;
    const stoppedReplaceFail = fixtureOptions.stoppedReplaceFail;
    const store =
      destroyPreFenceFail === undefined && stoppedReplaceFail === undefined
        ? baseStore
        : {
            ...baseStore,
            replace: (stackId: string, state: Parameters<typeof baseStore.replace>[1]) =>
              Effect.gen(function* () {
                if (state.desiredLifecycle === "destroying" && destroyPreFenceFail !== undefined) {
                  const fail = yield* Ref.get(destroyPreFenceFail);
                  if (fail) {
                    yield* Ref.set(destroyPreFenceFail, false);
                    return yield* new StackStateInvalidError({
                      message: "injected destroy fence failure",
                    });
                  }
                }
                if (state.desiredLifecycle === "stopped" && stoppedReplaceFail !== undefined) {
                  const fail = yield* Ref.get(stoppedReplaceFail);
                  if (fail) {
                    yield* Ref.set(stoppedReplaceFail, false);
                    return yield* new StackStateInvalidError({
                      message: "injected stopped-state persistence failure",
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
    const logOptions = yield* Ref.make<ReadonlyArray<LogQuery | undefined>>([]);
    const entry: StackLogEntry = {
      cursor: { opaque: "v1_1" },
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "auth",
      stream: "internal",
      message: "hello",
    };
    const finalEntry: StackLogEntry = {
      ...entry,
      cursor: { opaque: "v1_2" },
      timestamp: "2026-01-01T00:00:01.000Z",
      message: "stopped",
    };
    const logEntries = yield* Ref.make<ReadonlyArray<StackLogEntry>>([entry]);
    const failDestroy = yield* Ref.make(false);
    let gateStopCleanup = false;
    const driver: RuntimeDriver = {
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
              if (fixtureOptions.stopFailFirst !== undefined)
                yield* Ref.set(fixtureOptions.stopFailFirst, true);
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
          if (fixtureOptions.startFinished !== undefined && workload.id === "rest:rest")
            yield* Deferred.succeed(fixtureOptions.startFinished, undefined);
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
        Effect.gen(function* () {
          if (fixtureOptions.workloadRemoveFailFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.workloadRemoveFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.workloadRemoveFailFirst, false);
              return yield* new RuntimeDriverError({
                message: "injected workload remove failure",
                stackId: key.stackId,
                workloadId: key.workloadId,
              });
            }
          }
          yield* Ref.update(resources, (current) =>
            current.filter((entry) => entry.workloadId !== key.workloadId),
          );
        }),
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
          if (!destroy && gateStopCleanup)
            yield* Ref.update(logEntries, (current) => [...current, finalEntry]);
        }),
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
        read: (options) =>
          Ref.update(logOptions, (current) => [...current, options]).pipe(
            Effect.andThen(Ref.get(logEntries)),
          ),
        stream: () => Stream.empty,
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
  it.live("rejects new work after owner shutdown begins", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.shutdownIfIdle;

        const start = yield* fixture.supervisor.start().pipe(Effect.exit);
        expect(errorOf(start)).toBeInstanceOf(StackLifecycleConflictError);
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

  it.live("persists stopped after startup ingress failure", () =>
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
        expect(status.desiredLifecycle).toBe("stopped");
        expect(status.lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("persists stopped after a restart ingress failure", () =>
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
                          message: "injected start ingress failure",
                        }),
                      ),
                ),
              ),
            open: () => Effect.void,
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({ config: {} });
        yield* fixture.supervisor.maintenanceHandlers.stop;

        expect(Exit.isFailure(yield* fixture.supervisor.start().pipe(Effect.exit))).toBe(true);
        const status = yield* fixture.supervisor.status;
        expect(status.desiredLifecycle).toBe("stopped");
        expect(status.lifecycle).toBe("stopped");
        expect(errorOf(yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit))?.tag).toBe(
          "StackNotRunningError",
        );
        const retry = yield* fixture.supervisor.start().pipe(Effect.exit);
        expect(errorOf(retry)).toBeInstanceOf(StackLifecycleConflictError);
        expect(yield* Ref.get(fixture.calls)).toContain("start:database:database");
      }),
    ),
  );

  it.live("exits after a stopped-owner restart ingress failure", () =>
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
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
        expect(errorOf(yield* fixture.supervisor.start().pipe(Effect.exit))).toBeInstanceOf(
          StackLifecycleConflictError,
        );
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

  it.live("uses cold preflight when starting after a stop", () =>
    run(
      Effect.gen(function* () {
        const preflightModes = yield* Ref.make<ReadonlyArray<"cold" | "live">>([]);
        const fixture = yield* makeFixture({ preflightModes });
        yield* fixture.supervisor.start({ config: {} });
        yield* Ref.set(preflightModes, []);

        yield* fixture.supervisor.maintenanceHandlers.stop;
        yield* fixture.supervisor.start();
        expect(yield* Ref.get(preflightModes)).toEqual(["cold"]);

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
        yield* successor.start();
        expect(yield* Ref.get(preflightModes)).toEqual(["cold"]);
      }),
    ),
  );

  it.live("keeps the owner for retryable first-start cleanup", () =>
    run(
      Effect.gen(function* () {
        const stopFailFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({ stopFailFirst });
        const failed = yield* fixture.supervisor.start({ config: {} }).pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("unconfigured");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(yield* Ref.get(fixture.calls)).toEqual([]);
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("unconfigured");
      }),
    ),
  );

  it.live("keeps the owner when eager launch cleanup is unproven", () =>
    run(
      Effect.gen(function* () {
        const startFailures = yield* Ref.make(1);
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ startFailures, stopFailFirst });
        const failed = yield* fixture.supervisor
          .start({ config: { capabilities: { functions: { activation: "eager" } } } })
          .pipe(Effect.exit);

        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(yield* Ref.get(fixture.calls)).toContain("cleanup:stop");

        const retry = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(retry.ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("shuts down after a proven eager launch failure", () =>
    run(
      Effect.gen(function* () {
        const startFailures = yield* Ref.make(1);
        const fixture = yield* makeFixture({ startFailures });
        const failed = yield* fixture.supervisor
          .start({ config: { capabilities: { functions: { activation: "eager" } } } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
        yield* fixture.supervisor.shutdownIfIdle;
        yield* fixture.supervisor.shutdown;
      }),
    ),
  );

  it.live("keeps stopping when fresh-ingress cleanup fails, then recovers on explicit stop", () =>
    run(
      Effect.gen(function* () {
        const closeFailures = yield* Ref.make(2);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: true,
              }),
            open: () => Effect.void,
            close: Effect.gen(function* () {
              const remaining = yield* Ref.get(closeFailures);
              if (remaining > 0) {
                yield* Ref.set(closeFailures, remaining - 1);
                return yield* new StackReconciliationError({ message: "injected close failure" });
              }
            }),
          },
        });
        const failed = yield* fixture.supervisor.start({ config: {} }).pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(false);
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("unconfigured");
      }),
    ),
  );

  it.live("keeps stopping when persisting the stopped fence fails", () =>
    run(
      Effect.gen(function* () {
        const stoppedReplaceFail = yield* Ref.make(true);
        const startFailures = yield* Ref.make(1);
        const fixture = yield* makeFixture({ stoppedReplaceFail, startFailures });
        const failed = yield* fixture.supervisor
          .start({ config: { capabilities: { functions: { activation: "eager" } } } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("running");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
      }),
    ),
  );

  it.live("returns persisted database, API, and storage credentials while running", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
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

  it.live("reports stopping while stop cleanup is still in progress", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });

        const stop = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.await(stopStarted);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");

        yield* Deferred.succeed(stopGate, undefined);
        expect((yield* Fiber.join(stop)).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
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

  it.live("attempts runtime cleanup when session workload stop fails", () =>
    run(
      Effect.gen(function* () {
        const workloadStopFailFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({ workloadStopFailFirst });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
        yield* Ref.set(fixture.calls, []);

        const response = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(response.ok).toBe(false);
        expect(yield* Ref.get(fixture.calls)).toContain("cleanup:stop");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
      }),
    ),
  );

  it.live("stops the launched session in reverse dependency order", () =>
    run(
      Effect.gen(function* () {
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const fixture = yield* makeFixture({ timeline });
        yield* fixture.supervisor.start({
          config: { capabilities: { rest: { activation: "eager" } } },
        });
        yield* Ref.set(timeline, []);

        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect(yield* Ref.get(timeline)).toEqual([
          "stop:rest:rest",
          "stop:database:database",
          "cleanup:stop",
        ]);
      }),
    ),
  );

  it.live("keeps stopping state while an explicit stop is active", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });

        const stopping = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.await(stopStarted);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        yield* Deferred.succeed(stopGate, undefined);
        yield* Fiber.join(stopping);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
        const restart = yield* fixture.supervisor.start().pipe(Effect.exit);
        expect(errorOf(restart)).toBeInstanceOf(StackLifecycleConflictError);
      }),
    ),
  );

  it.live("reports destroying while persistent data cleanup is in progress", () =>
    run(
      Effect.gen(function* () {
        const destroyGate = yield* Deferred.make<void>();
        const destroyStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ destroyGate, destroyStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });

        const destroy = yield* Effect.forkChild(fixture.supervisor.destroy);
        yield* Deferred.await(destroyStarted);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("destroying");

        yield* Deferred.succeed(destroyGate, undefined);
        yield* Fiber.join(destroy);
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );

  it.live("destroys observed remnants from an unconfigured supervisor", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* Ref.set(fixture.resources, [
          { stackId: fixture.id, workloadId: "database:database", state: "ready" },
        ]);
        yield* fixture.supervisor.destroy;
        expect(yield* Ref.get(fixture.resources)).toEqual([]);
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );

  it.live("passes log query through the Supervisor log batch", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const options: LogQuery = { capabilities: ["auth"] };
        expect((yield* fixture.supervisor.logs(options)).entries).toHaveLength(1);
        expect(yield* Ref.get(fixture.logOptions)).toEqual([undefined]);
      }),
    ),
  );

  it.live("returns filtered log batches with a running marker", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const batch = yield* fixture.supervisor.logs({ capabilities: ["auth"], tail: 20 });
        expect(batch.entries.every((entry) => entry.source === "auth")).toBe(true);
        expect(batch.running).toBe(false);
      }),
    ),
  );

  it.live("reports stopped after a clean stop", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const response = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(response.ok).toBe(true);
        yield* fixture.supervisor.shutdownIfIdle;
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("keeps followers live through stop and returns final logs once", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const stopping = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.stop);
        yield* Deferred.await(stopStarted);
        const duringStop = yield* fixture.supervisor.logs();
        expect(duringStop.running).toBe(true);
        expect(duringStop.entries).toHaveLength(1);
        yield* Deferred.succeed(stopGate, undefined);
        const response = yield* Fiber.join(stopping);
        expect(response.ok).toBe(true);
        yield* fixture.supervisor.shutdownIfIdle;
        const batch = yield* fixture.supervisor.logs();
        expect(batch.entries).toHaveLength(2);
        expect(batch.entries.filter((entry) => entry.message === "stopped")).toHaveLength(1);
        expect(batch.running).toBe(false);
      }),
    ),
  );

  it.live("keeps running state and explicit stop guidance for changed start input", () =>
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

  it.live("keeps the owner when stop cannot prove its cleanup", () =>
    run(
      Effect.gen(function* () {
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ stopFailFirst });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Ref.set(stopFailFirst, true);

        const stopped = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(stopped.ok).toBe(false);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("stopped");

        const shutdown = yield* Effect.forkChild(fixture.supervisor.shutdown, {
          startImmediately: true,
        });
        yield* fixture.supervisor.shutdownIfIdle;
        expect(shutdown.pollUnsafe()).toBeUndefined();

        const stoppedAgain = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(stoppedAgain.ok).toBe(true);
        yield* fixture.supervisor.shutdownIfIdle;
        yield* Fiber.join(shutdown);
        expect(yield* Ref.get(fixture.resources)).toEqual([]);
      }),
    ),
  );

  it.live("requires explicit stop cleanup before starting again", () =>
    run(
      Effect.gen(function* () {
        const stopFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ stopFailFirst });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Ref.set(stopFailFirst, true);
        const failedStop = yield* fixture.supervisor.maintenanceHandlers.stop;
        expect(failedStop.ok).toBe(false);

        expect(errorOf(yield* fixture.supervisor.start().pipe(Effect.exit))).toBeInstanceOf(
          StackLifecycleConflictError,
        );
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        yield* Ref.set(fixture.calls, []);
        const started = yield* fixture.supervisor.start();

        expect(started.lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.calls)).toContain("start:database:database");
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
        const startGate = yield* Deferred.make<void>();
        const startStarted = yield* Deferred.make<void>();
        const startFinished = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ startGate, startStarted, startFinished });
        const config = {
          capabilities: { rest: { activation: "eager" } },
        } satisfies import("../public/Config.ts").StackConfig;
        const waiter = yield* Effect.forkChild(fixture.supervisor.start({ config }));
        yield* Deferred.await(startStarted);
        yield* Fiber.interrupt(waiter);
        yield* Deferred.succeed(startGate, undefined);
        yield* Deferred.await(startFinished);
        // shutdownIfIdle acquires the lifecycle admission permit, so it waits until the accepted
        // owner operation has released admission after publishing its running phase.
        yield* fixture.supervisor.shutdownIfIdle;

        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("running");
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
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

  it.live("rejects concurrent starts even with identical input", () =>
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
        const firstConfig = { capabilities: {} };
        const first = yield* Effect.forkChild(fixture.supervisor.start({ config: firstConfig }));
        yield* Deferred.await(preflightStarted);
        const second = yield* Effect.forkChild(fixture.supervisor.start({ config: firstConfig }));
        yield* Deferred.succeed(preflightGate, undefined);
        const [firstExit, secondExit] = yield* Effect.all([
          Fiber.join(first).pipe(Effect.exit),
          Fiber.join(second).pipe(Effect.exit),
        ]);
        expect(Exit.isFailure(firstExit)).toBe(true);
        expect(errorOf(secondExit)).toBeInstanceOf(StackLifecycleConflictError);
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

  it.live(
    "reports a post-ready workload failure without restarting it or stopping unrelated services",
    () =>
      run(
        Effect.gen(function* () {
          const starts = yield* Queue.unbounded<string>();
          const fixture = yield* makeFixture({ startQueue: starts });
          yield* fixture.supervisor.start({
            config: { capabilities: { rest: { activation: "eager" } } },
          });
          yield* Queue.take(starts);
          yield* Queue.take(starts);
          yield* Ref.set(fixture.calls, []);
          yield* Ref.update(fixture.resources, (current) =>
            current.map((entry) =>
              entry.workloadId === "database:database"
                ? { ...entry, state: "failed" as const, error: "crashed" }
                : entry,
            ),
          );
          const status = yield* fixture.supervisor.status;
          expect(status.capabilities.find(({ name }) => name === "database")?.state).toBe("failed");
          expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
          expect(yield* Ref.get(fixture.calls)).toEqual([]);
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
        expect(
          (yield* Ref.get(fixture.calls)).filter((call) => call === "start:functions:edge-runtime"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.live("reports a failed lazy activation as dormant until it is retried", () =>
    run(
      Effect.gen(function* () {
        const startFailures = yield* Ref.make(1);
        const fixture = yield* makeFixture({ startFailures });
        yield* fixture.supervisor.start({ config: { capabilities: { functions: {} } } });

        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);

        expect(Exit.isFailure(failed)).toBe(true);
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "functions")
            ?.state,
        ).toBe("dormant");
        const retry = yield* fixture.supervisor.activate("functions");
        expect(retry.endpoint).toEqual({ host: "127.0.0.1", port: 9999 });
        expect(
          (yield* fixture.supervisor.status).capabilities.find(({ name }) => name === "functions")
            ?.state,
        ).toBe("ready");
        expect(
          (yield* Ref.get(fixture.calls)).filter((call) => call === "start:functions:edge-runtime"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.live("rolls back a lazy launch when ingress opening fails", () =>
    run(
      Effect.gen(function* () {
        const openCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: true,
              }),
            open: () =>
              Ref.updateAndGet(openCalls, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 2
                    ? Effect.fail(new GatewayActivationError({ message: "injected open failure" }))
                    : Effect.void,
                ),
              ),
            close: Effect.void,
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* Ref.get(fixture.resources)).toEqual([
          expect.objectContaining({ workloadId: "database:database", state: "ready" }),
        ]);
        yield* fixture.supervisor.activate("functions");
        expect(
          (yield* Ref.get(fixture.calls)).filter((call) => call === "start:functions:edge-runtime"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.live("fences fresh ingress when open failure cleanup is not proven", () =>
    run(
      Effect.gen(function* () {
        const openCalls = yield* Ref.make(0);
        const closeFailures = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: true,
              }),
            open: () =>
              Ref.updateAndGet(openCalls, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 2
                    ? Effect.fail(new GatewayActivationError({ message: "injected open failure" }))
                    : Effect.void,
                ),
              ),
            close: Effect.gen(function* () {
              const remaining = yield* Ref.get(closeFailures);
              if (remaining > 0) {
                yield* Ref.set(closeFailures, remaining - 1);
                return yield* new StackReconciliationError({ message: "injected close failure" });
              }
            }),
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        yield* Ref.set(closeFailures, 1);
        expect(
          Exit.isFailure(yield* fixture.supervisor.activate("functions").pipe(Effect.exit)),
        ).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("rolls back fresh ingress after activation failure and retries", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(true);
        const openCalls = yield* Ref.make(0);
        const closeCalls = yield* Ref.make(0);
        const fixture = yield* makeFixture({
          activationFailFirst,
          ingress: {
            acquire: () =>
              Effect.succeed({
                assignments: {},
                privateAssignments: [],
                hostListeners: [],
                fresh: true,
              }),
            open: () => Ref.update(openCalls, (count) => count + 1),
            close: Ref.update(closeCalls, (count) => count + 1),
          },
        });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        expect(
          Exit.isFailure(yield* fixture.supervisor.activate("functions").pipe(Effect.exit)),
        ).toBe(true);
        expect(yield* Ref.get(closeCalls)).toBe(2);
        expect(yield* Ref.get(fixture.resources)).toEqual([
          expect.objectContaining({ workloadId: "database:database", state: "ready" }),
        ]);
        const retry = yield* fixture.supervisor.activate("functions");
        expect(retry.endpoint).toEqual({ host: "127.0.0.1", port: 9999 });
        expect(yield* Ref.get(openCalls)).toBe(3);
      }),
    ),
  );

  it.live("fences the owner when lazy rollback cannot be proven", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(true);
        const workloadStopFailFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({ activationFailFirst, workloadStopFailFirst });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(
          errorOf(yield* fixture.supervisor.activate("functions").pipe(Effect.exit)),
        ).toBeInstanceOf(StackLifecycleConflictError);
        expect(errorOf(yield* fixture.supervisor.start().pipe(Effect.exit))).toBeInstanceOf(
          StackLifecycleConflictError,
        );
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        yield* fixture.supervisor.shutdown;
        const successor = yield* makeSupervisor({
          identity,
          stackId: fixture.id,
          ownerSessionId: "successor-session",
          rpcRelease: "test-release",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        expect((yield* successor.start()).lifecycle).toBe("running");
        expect((yield* successor.maintenanceHandlers.stop).ok).toBe(true);
      }),
    ),
  );

  it.live("fences the owner when lazy rollback remove fails", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(true);
        const workloadRemoveFailFirst = yield* Ref.make(true);
        const fixture = yield* makeFixture({ activationFailFirst, workloadRemoveFailFirst });
        yield* fixture.supervisor.start({
          config: { capabilities: { functions: { activation: "lazy" } } },
        });
        const failed = yield* fixture.supervisor.activate("functions").pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("validates lifecycle before cached lazy activation results", () =>
    run(
      Effect.gen(function* () {
        const activationFailFirst = yield* Ref.make(false);
        const workloadRemoveFailFirst = yield* Ref.make(false);
        const fixture = yield* makeFixture({ activationFailFirst, workloadRemoveFailFirst });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              functions: { activation: "lazy" },
              auth: { activation: "lazy" },
            },
          },
        });
        yield* fixture.supervisor.activate("functions");
        yield* Ref.set(activationFailFirst, true);
        yield* Ref.set(workloadRemoveFailFirst, true);
        expect(Exit.isFailure(yield* fixture.supervisor.activate("auth").pipe(Effect.exit))).toBe(
          true,
        );
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopping");
        expect(
          errorOf(yield* fixture.supervisor.activate("functions").pipe(Effect.exit)),
        ).toBeInstanceOf(StackLifecycleConflictError);
        expect((yield* fixture.supervisor.maintenanceHandlers.stop).ok).toBe(true);
        expect(
          errorOf(yield* fixture.supervisor.activate("functions").pipe(Effect.exit)),
        ).toBeInstanceOf(StackNotRunningError);
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
