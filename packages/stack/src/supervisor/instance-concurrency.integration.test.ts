import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Ref,
  Scope,
  Stream,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import { deriveStackId } from "../identity/Identity.ts";
import { compileServiceInstance, compileServiceRestart } from "../model/Compiler.ts";
import type { SnapshotDescriptor } from "../public/Service.ts";
import type { ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import { StackLifecycleConflictError, StackStateInvalidError } from "../public/Errors.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { AUTH_JWT_SECRET_SLOT } from "../state/SecretStore.ts";
import { makeInstanceEngine } from "./InstanceEngine.ts";
import type { SupervisorRuntime } from "./Supervisor.ts";
import type { InstanceRuntimeInput } from "./Lifecycle.ts";

const makeFixture = (
  pauseAfterStartAdmission = false,
  pauseFirstStop = false,
  failEndpointPublication = false,
  failRuntimeStop = false,
  failRuntimeDestroy = false,
  pauseHandoffCleanup = false,
  failHandoffCleanup = false,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-instance-concurrency-" });
    const identity = { projectRoot: root, branchContext: "test", stackName: "concurrency" };
    const stackId = yield* deriveStackId(identity);
    const store = yield* makeStackStateStore({ stateRoot: path.join(root, "state") });
    yield* store.initialize(stackId, {
      format: "supabase-stack-state-v2",
      identity,
      runtime: { kind: "native" },
      preparation: "on-demand",
      security: {
        jwt: {
          issuer: null,
          expirySeconds: 3600,
          signing: { kind: "symmetric", secret: { slot: AUTH_JWT_SECRET_SLOT } },
        },
      },
      listeners: {},
      registry: { initialized: true, instances: [], defaultInstanceIds: {} },
      ports: [],
      privatePorts: [],
      secrets: { [AUTH_JWT_SECRET_SLOT]: { policy: "managed", value: "concurrency-test-secret" } },
    });
    const context = { projectRoot: root, path, runtime: { kind: "native" } as const };
    const database = yield* compileServiceInstance(
      { service: "database", name: "shadow", config: { endpoints: { sql: { enabled: false } } } },
      context,
    );
    const functions = yield* compileServiceInstance(
      { service: "functions", name: "functions", config: { activation: "lazy" } },
      context,
    );
    const enteredStart = yield* Deferred.make<void>();
    const releaseStart = yield* Deferred.make<void>();
    const enteredDependentStart = yield* Deferred.make<void>();
    const releaseDependentStart = yield* Deferred.make<void>();
    const pauseDependentStart = yield* Ref.make(false);
    const enteredExport = yield* Deferred.make<void>();
    const releaseExport = yield* Deferred.make<void>();
    const admittedStart = yield* Deferred.make<void>();
    const releaseAdmission = yield* Deferred.make<void>();
    const admissionPaused = yield* Ref.make(false);
    const pauseBatchAdmission = yield* Ref.make(false);
    const batchAdmissionPaused = yield* Ref.make(false);
    const admittedBatch = yield* Deferred.make<void>();
    const releaseBatchAdmission = yield* Deferred.make<void>();
    const handoffCleanupPaused = yield* Ref.make(false);
    const admittedHandoffCleanup = yield* Deferred.make<void>();
    const releaseHandoffCleanup = yield* Deferred.make<void>();
    const pauseStudioAdmission = yield* Ref.make(false);
    const studioAdmissionPaused = yield* Ref.make(false);
    const admittedStudio = yield* Deferred.make<void>();
    const releaseStudioAdmission = yield* Deferred.make<void>();
    const admittedSleep = yield* Deferred.make<void>();
    const releaseSleepAdmission = yield* Deferred.make<void>();
    const pauseSleepAdmission = yield* Ref.make(false);
    const sleepAdmissionPaused = yield* Ref.make(false);
    const ready = yield* Ref.make<ReadonlySet<ServiceInstanceId>>(new Set());
    const active = yield* Ref.make<ReadonlySet<ServiceInstanceId>>(new Set());
    const starts = yield* Ref.make<ReadonlyArray<ServiceInstanceId>>([]);
    const enteredStop = yield* Deferred.make<ServiceInstanceId>();
    const releaseStop = yield* Deferred.make<void>();
    const stopPaused = yield* Ref.make(false);
    const runtimeStopFails = yield* Ref.make(failRuntimeStop);
    const runtimeDestroyFails = yield* Ref.make(failRuntimeDestroy);
    const failHandoffCleanupOnce = yield* Ref.make(failHandoffCleanup);
    const snapshot = (input: InstanceRuntimeInput): SnapshotDescriptor => ({
      lineageId: "source-lineage",
      initializationProfileId: null,
      artifactIdentity: "postgres-test",
      runtimeIdentity: "native",
      dataFormat: { provider: "postgres", format: "pgdata", majorVersion: 17 },
      provenance: { sourceInstanceId: input.instance.id, exportOperationId: input.operation.id },
    });
    const runtime: Pick<
      SupervisorRuntime,
      "prepare" | "start" | "stop" | "destroy" | "exportSnapshot" | "restoreSnapshot"
    > = {
      prepare: () => Effect.succeed({ instances: [] }),
      start: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(starts, (ids) => [...ids, input.instance.id]);
          if (input.instance.id === database.id) {
            yield* Deferred.succeed(enteredStart, undefined);
            yield* Deferred.await(releaseStart);
          }
          if (input.instance.id !== database.id && (yield* Ref.get(pauseDependentStart))) {
            yield* Deferred.succeed(enteredDependentStart, undefined);
            yield* Deferred.await(releaseDependentStart);
          }
          yield* Ref.update(ready, (ids) => new Set(ids).add(input.instance.id));
          return [];
        }),
      stop: (input) =>
        Effect.gen(function* () {
          if (yield* Ref.get(runtimeStopFails))
            return yield* new StackLifecycleConflictError({ message: "runtime cleanup failed" });
          if (pauseFirstStop && !(yield* Ref.getAndSet(stopPaused, true))) {
            yield* Deferred.succeed(enteredStop, input.instance.id);
            yield* Deferred.await(releaseStop);
          }
          yield* Ref.update(
            ready,
            (ids) => new Set([...ids].filter((id) => id !== input.instance.id)),
          );
        }),
      destroy: (input) =>
        Effect.gen(function* () {
          if (yield* Ref.get(runtimeDestroyFails))
            return yield* new StackLifecycleConflictError({ message: "runtime destroy failed" });
          yield* Ref.update(
            ready,
            (ids) => new Set([...ids].filter((id) => id !== input.instance.id)),
          );
        }),
      exportSnapshot: (input) =>
        Deferred.succeed(enteredExport, undefined).pipe(
          Effect.andThen(Deferred.await(releaseExport)),
          Effect.as(snapshot(input)),
        ),
      restoreSnapshot: (input) => Effect.succeed(snapshot(input)),
    };
    const engineStore: typeof store = {
      ...store,
      update: (id, transform) =>
        store.update(id, transform).pipe(
          Effect.flatMap((saved) =>
            saved.registry.instances.some(
              (instance) =>
                instance.id === database.id &&
                instance.intent === "started" &&
                instance.pendingOperation === null,
            )
              ? Ref.getAndSet(failHandoffCleanupOnce, false).pipe(
                  Effect.flatMap((fail) =>
                    fail
                      ? Effect.fail(
                          new StackStateInvalidError({
                            message: "handoff journal cleanup failed",
                          }),
                        )
                      : Effect.succeed(saved),
                  ),
                )
              : Effect.succeed(saved),
          ),
          Effect.tap((saved) =>
            Effect.gen(function* () {
              if (
                pauseAfterStartAdmission &&
                saved.registry.instances.some(
                  (instance) =>
                    instance.id === database.id && instance.pendingOperation?.kind === "start",
                ) &&
                !(yield* Ref.getAndSet(admissionPaused, true))
              ) {
                yield* Deferred.succeed(admittedStart, undefined);
                yield* Deferred.await(releaseAdmission);
              }
              if (
                (yield* Ref.get(pauseStudioAdmission)) &&
                saved.registry.instances.some(
                  (instance) =>
                    instance.name === "partial-lease-studio" &&
                    instance.pendingOperation?.kind === "start",
                ) &&
                !(yield* Ref.getAndSet(studioAdmissionPaused, true))
              ) {
                yield* Deferred.succeed(admittedStudio, undefined);
                yield* Deferred.await(releaseStudioAdmission);
              }
              if (
                (yield* Ref.get(pauseBatchAdmission)) &&
                saved.registry.instances.some(
                  (instance) => instance.pendingOperation?.kind === "start",
                ) &&
                !(yield* Ref.getAndSet(batchAdmissionPaused, true))
              ) {
                yield* Deferred.succeed(admittedBatch, undefined);
                yield* Deferred.await(releaseBatchAdmission);
              }
              if (
                pauseHandoffCleanup &&
                saved.registry.instances.some(
                  (instance) =>
                    instance.id === database.id &&
                    instance.intent === "started" &&
                    instance.pendingOperation === null,
                ) &&
                !(yield* Ref.getAndSet(handoffCleanupPaused, true))
              ) {
                yield* Deferred.succeed(admittedHandoffCleanup, undefined);
                yield* Deferred.await(releaseHandoffCleanup);
              }
              if (
                (yield* Ref.get(pauseSleepAdmission)) &&
                saved.registry.instances.some(
                  (instance) => instance.pendingOperation?.kind === "sleep",
                ) &&
                !(yield* Ref.getAndSet(sleepAdmissionPaused, true))
              ) {
                yield* Deferred.succeed(admittedSleep, undefined);
                yield* Deferred.await(releaseSleepAdmission);
              }
            }),
          ),
        ),
    };
    const engine = yield* makeInstanceEngine({
      stackId,
      ownerSessionId: "concurrency-owner",
      stateStore: engineStore,
      runtime,
      scope: yield* Scope.Scope,
      context: yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>(),
      isInstanceActive: (id) => Ref.get(active).pipe(Effect.map((ids) => ids.has(id))),
      ...(failEndpointPublication
        ? {
            publishEndpoints: () =>
              Effect.fail(
                new StackLifecycleConflictError({ message: "endpoint publication failed" }),
              ),
          }
        : {}),
    });
    yield* engine.create(database.instance, database.secretSlots);
    yield* engine.create(functions.instance, functions.secretSlots);
    return {
      context,
      engine,
      store,
      stackId,
      database,
      functions,
      ready,
      active,
      starts,
      enteredStop,
      releaseStop,
      runtimeStopFails,
      runtimeDestroyFails,
      failHandoffCleanupOnce,
      enteredStart,
      releaseStart,
      enteredDependentStart,
      releaseDependentStart,
      pauseDependentStart,
      enteredExport,
      releaseExport,
      admittedStart,
      releaseAdmission,
      pauseBatchAdmission,
      admittedBatch,
      releaseBatchAdmission,
      handoffCleanupPaused,
      admittedHandoffCleanup,
      releaseHandoffCleanup,
      pauseStudioAdmission,
      admittedStudio,
      releaseStudioAdmission,
      admittedSleep,
      releaseSleepAdmission,
      pauseSleepAdmission,
    };
  });
const fixture = makeFixture();

describe("instance operation isolation with durable transactions", () => {
  it.effect("automatically sleeps an eligible instance after its configured idle interval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Deferred.succeed(f.releaseStart, undefined);
        const rest = yield* compileServiceInstance(
          {
            service: "rest",
            name: "idle-rest",
            config: { activation: "lazy", idleTimeoutSeconds: 5 },
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        yield* f.engine.create(rest.instance, rest.secretSlots);
        yield* f.engine.start(rest.id);
        expect((yield* f.engine.status(rest.id)).phase).toBe("ready");
        const observing = yield* Deferred.make<void>();
        const slept = yield* f.engine.followStatus(rest.id).pipe(
          Stream.tap((status) =>
            status.phase === "ready" ? Deferred.succeed(observing, undefined) : Effect.void,
          ),
          Stream.filter((status) => status.phase === "dormant"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(observing);
        yield* TestClock.adjust("4 seconds");
        expect((yield* f.engine.status(rest.id)).phase).toBe("ready");
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(slept);
        expect(yield* f.engine.status(rest.id)).toMatchObject({
          phase: "dormant",
          intent: "started",
        });
        expect((yield* Ref.get(f.ready)).has(rest.id)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps active traffic awake and rearms idle retirement when the traffic ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Deferred.succeed(f.releaseStart, undefined);
        const rest = yield* compileServiceInstance(
          {
            service: "rest",
            name: "active-rest",
            config: { activation: "lazy", idleTimeoutSeconds: 5 },
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        yield* f.engine.create(rest.instance, rest.secretSlots);
        yield* f.engine.start(rest.id);
        const release = yield* f.engine.acquireTraffic(rest.id);
        yield* TestClock.adjust("10 seconds");
        expect((yield* f.engine.status(rest.id)).phase).toBe("ready");
        expect((yield* Ref.get(f.ready)).has(rest.id)).toBe(true);
        yield* release.release;
        const observing = yield* Deferred.make<void>();
        const slept = yield* f.engine.followStatus(rest.id).pipe(
          Stream.tap((status) =>
            status.phase === "ready" ? Deferred.succeed(observing, undefined) : Effect.void,
          ),
          Stream.filter((status) => status.phase === "dormant"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(observing);
        yield* TestClock.adjust("4 seconds");
        expect((yield* f.engine.status(rest.id)).phase).toBe("ready");
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(slept);
        expect(yield* f.engine.status(rest.id)).toMatchObject({
          phase: "dormant",
          intent: "started",
        });
        expect((yield* Ref.get(f.ready)).has(rest.id)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("waits for readiness before admitting ordinary traffic", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(true, true);
        const rest = yield* compileServiceInstance(
          {
            service: "rest",
            name: "startup-control-rest",
            config: { activation: "lazy" },
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        yield* f.engine.create(rest.instance, rest.secretSlots);

        const unclaimed = yield* f.engine.acquireTraffic(rest.id, "startup-control");
        yield* unclaimed.release;

        const starting = yield* f.engine
          .start(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedStart);
        const startup = yield* f.engine.acquireTraffic(f.database.id, "startup-control");
        const ordinary = yield* f.engine
          .acquireTraffic(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect((yield* f.engine.status(f.database.id)).pendingOperation?.kind).toBe("start");
        yield* startup.release;
        yield* Deferred.succeed(f.releaseAdmission, undefined);
        yield* Deferred.succeed(f.releaseStart, undefined);
        expect((yield* Fiber.join(starting)).phase).toBe("ready");
        yield* (yield* Fiber.join(ordinary)).release;

        const ready = yield* f.engine.acquireTraffic(f.database.id, "startup-control");
        yield* ready.release;

        const stopping = yield* f.engine
          .stop(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.enteredStop);
        const duringRetirement = yield* f.engine
          .acquireTraffic(f.database.id)
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(duringRetirement.pollUnsafe()).toBeUndefined();
        const duringStop = yield* f.engine
          .acquireTraffic(f.database.id, "startup-control")
          .pipe(Effect.exit);
        expect(Exit.isFailure(duringStop)).toBe(true);
        yield* Deferred.succeed(f.releaseStop, undefined);
        expect((yield* Fiber.join(stopping)).phase).toBe("stopped");
        expect(Exit.isFailure(yield* Fiber.join(duringRetirement))).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("waits through sleep before admitting traffic to a dormant started instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, true);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.start(f.database.id);
        const sleeping = yield* f.engine
          .sleep(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.enteredStop);
        const traffic = yield* f.engine
          .acquireTraffic(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(traffic.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(f.releaseStop, undefined);
        expect((yield* Fiber.join(sleeping)).phase).toBe("dormant");
        const lease = yield* Fiber.join(traffic);
        expect((yield* f.engine.start(f.database.id)).phase).toBe("ready");
        yield* lease.release;
        expect((yield* f.engine.stop(f.database.id)).phase).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("stopAll supersedes an in-flight start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(true);
        const starting = yield* f.engine
          .start(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedStart);
        const stopping = yield* f.engine
          .stopAll([f.database.id])
          .pipe(Effect.forkChild({ startImmediately: true }));
        const statuses = yield* Fiber.join(stopping);
        expect(statuses[0]?.phase).toBe("stopped");
        const startExit = yield* Fiber.join(starting).pipe(Effect.exit);
        expect(Exit.isFailure(startExit)).toBe(true);
        if (Exit.isFailure(startExit))
          expect(Option.getOrUndefined(Cause.findErrorOption(startExit.cause))).toBeInstanceOf(
            StackLifecycleConflictError,
          );
        yield* Deferred.succeed(f.releaseAdmission, undefined);
        yield* Deferred.succeed(f.releaseStart, undefined);
        expect((yield* f.engine.start(f.database.id)).phase).toBe("ready");
        const traffic = yield* f.engine.acquireTraffic(f.database.id);
        yield* traffic.release;
        expect((yield* f.engine.stop(f.database.id)).phase).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("startAll joins an in-flight single-instance start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(true);
        const starting = yield* f.engine
          .start(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedStart);
        const batchStarting = yield* f.engine
          .startAll([f.database.id])
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(f.releaseAdmission, undefined);
        yield* Deferred.succeed(f.releaseStart, undefined);
        expect((yield* Fiber.join(starting)).phase).toBe("ready");
        expect((yield* Fiber.join(batchStarting))[0]?.phase).toBe("ready");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("shares a start owner when its first waiter is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(true);
        const first = yield* f.engine
          .start(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedStart);
        const second = yield* f.engine
          .start(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(f.releaseAdmission, undefined);
        yield* Deferred.succeed(f.releaseStart, undefined);
        expect((yield* Fiber.join(second)).phase).toBe("ready");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps a batch start owner alive when its caller is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false);
        yield* Ref.set(f.pauseBatchAdmission, true);
        const starting = yield* f.engine
          .startAll([f.database.id])
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedBatch);
        const traffic = yield* f.engine
          .acquireTraffic(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(traffic.pollUnsafe()).toBeUndefined();
        const interruption = yield* Effect.forkChild(Fiber.interrupt(starting), {
          startImmediately: true,
        });
        yield* Deferred.succeed(f.releaseBatchAdmission, undefined);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* Fiber.join(interruption).pipe(Effect.timeout("5 seconds"));
        const lease = yield* Fiber.join(traffic).pipe(Effect.timeout("5 seconds"));
        yield* lease.release;
        expect((yield* f.engine.status(f.database.id)).phase).toBe("ready");
        expect((yield* f.engine.stop(f.database.id)).phase).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("settles traffic that observed a superseded batch start claim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(true);
        const starting = yield* f.engine
          .start(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedStart);
        yield* Ref.set(f.pauseBatchAdmission, true);
        const stopping = yield* f.engine
          .stopAll([f.database.id])
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedBatch);
        const traffic = yield* f.engine
          .acquireTraffic(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(traffic.pollUnsafe()).toBeUndefined();
        expect(Exit.isFailure(yield* f.engine.stopAll([f.database.id]).pipe(Effect.exit))).toBe(
          true,
        );
        expect(Exit.isFailure(yield* f.engine.stop(f.database.id).pipe(Effect.exit))).toBe(true);
        yield* Deferred.succeed(f.releaseBatchAdmission, undefined);
        expect((yield* Fiber.join(stopping))[0]?.phase).toBe("stopped");
        expect(Exit.isFailure(yield* Fiber.join(traffic).pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* Fiber.join(starting).pipe(Effect.exit))).toBe(true);
        yield* Deferred.succeed(f.releaseAdmission, undefined);
        yield* Deferred.succeed(f.releaseStart, undefined);
        expect((yield* f.engine.start(f.database.id)).phase).toBe("ready");
        expect((yield* f.engine.stop(f.database.id)).phase).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps a superseded stop owner alive when its caller is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(true, true, false, false, false, true);
        const starting = yield* f.engine
          .start(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedStart);
        yield* Deferred.succeed(f.releaseAdmission, undefined);
        const stopping = yield* f.engine
          .stop(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedHandoffCleanup);
        yield* Fiber.interrupt(stopping);
        yield* Deferred.succeed(f.releaseHandoffCleanup, undefined);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* Deferred.await(f.enteredStop).pipe(Effect.timeout("5 seconds"));
        const traffic = yield* f.engine
          .acquireTraffic(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(traffic.pollUnsafe()).toBeUndefined();
        const settled = yield* f.engine.followStatus(f.database.id).pipe(
          Stream.takeUntil((status) => status.phase === "stopped"),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(f.releaseStop, undefined);
        yield* Fiber.join(settled);
        expect((yield* f.engine.status(f.database.id)).phase).toBe("stopped");
        expect(Exit.isFailure(yield* Fiber.join(traffic).pipe(Effect.exit))).toBe(true);
        expect((yield* f.engine.stop(f.database.id)).phase).toBe("stopped");
        expect(Exit.isFailure(yield* Fiber.join(starting).pipe(Effect.exit))).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fences a superseded stop when its journal cleanup fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(true, false, false, false, false, false, true);
        const starting = yield* f.engine
          .start(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedStart);
        yield* Deferred.succeed(f.releaseAdmission, undefined);
        yield* Ref.set(f.failHandoffCleanupOnce, true);
        const stopped = yield* f.engine.stop(f.database.id).pipe(Effect.exit);
        expect(Exit.isFailure(stopped)).toBe(true);
        yield* Deferred.succeed(f.releaseStart, undefined);
        expect((yield* f.engine.status(f.database.id)).phase).toBe("recovery");
        expect(
          Exit.isFailure(yield* f.engine.acquireTraffic(f.database.id).pipe(Effect.exit)),
        ).toBe(true);
        expect((yield* f.engine.stop(f.database.id)).phase).toBe("stopped");
        expect(Exit.isFailure(yield* Fiber.join(starting).pipe(Effect.exit))).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("cleans up a runtime when endpoint publication fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, false, true);
        yield* Deferred.succeed(f.releaseStart, undefined);

        const started = yield* f.engine.start(f.database.id).pipe(Effect.exit);
        expect(Exit.isFailure(started)).toBe(true);
        expect((yield* Ref.get(f.ready)).has(f.database.id)).toBe(false);
        expect((yield* f.engine.status(f.database.id)).phase).toBe("failed");
        expect((yield* f.engine.status(f.functions.id)).phase).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the startup fence when publication cleanup fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, false, true, true);
        yield* Deferred.succeed(f.releaseStart, undefined);

        const started = yield* f.engine.start(f.database.id).pipe(Effect.exit);
        expect(Exit.isFailure(started)).toBe(true);
        expect((yield* f.engine.status(f.database.id)).phase).toBe("recovery");
        expect((yield* f.engine.status(f.database.id)).pendingOperation?.kind).toBe("start");
        expect((yield* f.engine.status(f.database.id)).recovery?.operation).toBe("stop");
        yield* Ref.set(f.runtimeStopFails, false);
        expect((yield* f.engine.stop(f.database.id)).phase).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fences traffic after a failed stop until cleanup is retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, false, false, true);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.start(f.database.id);
        const stopped = yield* f.engine.stop(f.database.id).pipe(Effect.exit);
        expect(Exit.isFailure(stopped)).toBe(true);
        expect(yield* f.engine.status(f.database.id)).toMatchObject({
          intent: "stopped",
          phase: "recovery",
          pendingOperation: { kind: "stop" },
          recovery: { operation: "stop" },
        });
        expect(
          Exit.isFailure(yield* f.engine.acquireTraffic(f.database.id).pipe(Effect.exit)),
        ).toBe(true);
        yield* Ref.set(f.runtimeStopFails, false);
        expect((yield* f.engine.stop(f.database.id)).phase).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fences traffic after a failed sleep until cleanup is retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, false, false, true);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.start(f.database.id);
        expect(Exit.isFailure(yield* f.engine.sleep(f.database.id).pipe(Effect.exit))).toBe(true);
        expect(yield* f.engine.status(f.database.id)).toMatchObject({
          intent: "started",
          phase: "recovery",
          pendingOperation: { kind: "sleep" },
          recovery: { operation: "stop" },
        });
        expect(
          Exit.isFailure(yield* f.engine.acquireTraffic(f.database.id).pipe(Effect.exit)),
        ).toBe(true);
        yield* Ref.set(f.runtimeStopFails, false);
        expect((yield* f.engine.stop(f.database.id)).phase).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fences traffic after a failed restart teardown until cleanup is retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, false, false, true);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.start(f.database.id);
        expect(Exit.isFailure(yield* f.engine.restart(f.database.id).pipe(Effect.exit))).toBe(true);
        expect(yield* f.engine.status(f.database.id)).toMatchObject({
          intent: "started",
          phase: "recovery",
          pendingOperation: { kind: "restart" },
          recovery: { operation: "stop" },
        });
        expect(
          Exit.isFailure(yield* f.engine.acquireTraffic(f.database.id).pipe(Effect.exit)),
        ).toBe(true);
        yield* Ref.set(f.runtimeStopFails, false);
        expect((yield* f.engine.stop(f.database.id)).phase).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("destroys a publication cleanup fence in the same owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, false, true, true);
        yield* Deferred.succeed(f.releaseStart, undefined);
        expect(Exit.isFailure(yield* f.engine.start(f.database.id).pipe(Effect.exit))).toBe(true);
        yield* Ref.set(f.runtimeStopFails, false);
        yield* f.engine.destroy(f.database.id);
        expect((yield* f.engine.list).some(({ id }) => id === f.database.id)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains stopped intent after a failed destroy until cleanup is retried", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, false, false, false, true);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.start(f.database.id);
        expect(Exit.isFailure(yield* f.engine.destroy(f.database.id).pipe(Effect.exit))).toBe(true);
        expect(yield* f.engine.status(f.database.id)).toMatchObject({
          intent: "stopped",
          phase: "recovery",
          pendingOperation: { kind: "destroy" },
          recovery: { operation: "destroy" },
        });
        yield* Ref.set(f.runtimeDestroyFails, false);
        yield* f.engine.destroy(f.database.id);
        expect((yield* f.engine.list).some(({ id }) => id === f.database.id)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("destroyAll supersedes an in-flight start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(true);
        const starting = yield* f.engine
          .start(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedStart);
        yield* f.engine.destroyAll([f.database.id]);
        expect(Exit.isFailure(yield* Fiber.join(starting).pipe(Effect.exit))).toBe(true);
        expect((yield* f.engine.list).some(({ id }) => id === f.database.id)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects explicit sleep of a stopped instance without admitting it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const before = yield* f.engine.status(f.database.id);
        expect(before).toMatchObject({ intent: "stopped", phase: "stopped" });
        const slept = yield* f.engine.sleep(f.database.id).pipe(Effect.exit);
        expect(Exit.isFailure(slept)).toBe(true);
        expect(yield* f.engine.status(f.database.id)).toEqual(before);
        expect(yield* Ref.get(f.ready)).toEqual(new Set());
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reserves every batch sleep member before waiting for a slow selected stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, true);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.startAll([f.database.id, f.functions.id]);
        const sleeping = yield* f.engine
          .sleepAll([f.database.id, f.functions.id])
          .pipe(Effect.forkChild);
        const stopping = yield* Effect.raceFirst(
          Deferred.await(f.enteredStop),
          Fiber.join(sleeping).pipe(
            Effect.andThen(
              Effect.die(new Error("Batch sleep completed without stopping a runtime")),
            ),
          ),
        );
        const other = stopping === f.database.id ? f.functions.id : f.database.id;
        const restarted = yield* f.engine.restart(other).pipe(Effect.exit);
        yield* Deferred.succeed(f.releaseStop, undefined);
        yield* Fiber.join(sleeping);
        expect(Exit.isFailure(restarted)).toBe(true);
        if (Exit.isFailure(restarted))
          expect(Option.getOrUndefined(Cause.findErrorOption(restarted.cause))).toBeInstanceOf(
            StackLifecycleConflictError,
          );
        expect((yield* f.engine.status(f.database.id)).phase).toBe("dormant");
        expect((yield* f.engine.status(f.functions.id)).phase).toBe("dormant");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "rejects stopping or restarting a database with a ready dependent outside selection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          const rest = yield* compileServiceInstance(
            {
              service: "rest",
              name: "rest",
              config: {},
              dependencies: { database: f.database.id },
            },
            f.context,
          );
          yield* f.engine.create(rest.instance, rest.secretSlots);
          yield* Deferred.succeed(f.releaseStart, undefined);
          yield* f.engine.start(rest.id);
          expect((yield* f.engine.status(rest.id)).phase).toBe("ready");
          expect(yield* f.engine.stop(f.database.id).pipe(Effect.flip)).toBeInstanceOf(
            StackLifecycleConflictError,
          );
          expect(yield* f.engine.restart(f.database.id).pipe(Effect.flip)).toBeInstanceOf(
            StackLifecycleConflictError,
          );
          expect((yield* f.engine.status(f.database.id)).phase).toBe("ready");
          expect((yield* f.engine.status(rest.id)).phase).toBe("ready");
          expect(yield* Ref.get(f.starts)).toEqual([f.database.id, rest.id]);
          yield* f.engine.stopAll([rest.id, f.database.id]);
          expect((yield* f.engine.status(f.database.id)).phase).toBe("stopped");
          expect((yield* f.engine.status(rest.id)).phase).toBe("stopped");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects targeted teardown before superseding a joined dependency start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(true);
        const rest = yield* compileServiceInstance(
          {
            service: "rest",
            name: "joined-rest",
            config: {},
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        yield* f.engine.create(rest.instance, rest.secretSlots);
        const starting = yield* f.engine
          .start(rest.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.admittedStart);
        const stopped = yield* f.engine.stop(f.database.id).pipe(Effect.exit);
        const destroyed = yield* f.engine.destroy(f.database.id).pipe(Effect.exit);
        expect(Exit.isFailure(stopped)).toBe(true);
        expect(Exit.isFailure(destroyed)).toBe(true);
        if (Exit.isFailure(stopped))
          expect(Option.getOrUndefined(Cause.findErrorOption(stopped.cause))).toBeInstanceOf(
            StackLifecycleConflictError,
          );
        if (Exit.isFailure(destroyed))
          expect(Option.getOrUndefined(Cause.findErrorOption(destroyed.cause))).toBeInstanceOf(
            StackLifecycleConflictError,
          );
        expect((yield* f.engine.status(f.database.id)).pendingOperation?.kind).toBe("start");
        expect((yield* f.engine.status(rest.id)).pendingOperation?.kind).toBe("start");
        yield* Deferred.succeed(f.releaseAdmission, undefined);
        yield* Deferred.succeed(f.releaseStart, undefined);
        expect((yield* Fiber.join(starting)).phase).toBe("ready");
        const statuses = yield* f.engine.stopAll();
        expect(statuses.every((status) => status.phase === "stopped")).toBe(true);
        expect((yield* f.engine.status(f.database.id)).pendingOperation).toBeUndefined();
        expect((yield* f.engine.status(rest.id)).pendingOperation).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("protects a ready dependent while allowing an already dormant one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, true);
        const rest = yield* compileServiceInstance(
          {
            service: "rest",
            name: "sleep-dependent-rest",
            config: { activation: "lazy" },
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        yield* f.engine.create(rest.instance, rest.secretSlots);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.start(rest.id);
        expect((yield* f.engine.status(rest.id)).phase).toBe("ready");
        expect(yield* f.engine.sleep(f.database.id).pipe(Effect.flip)).toBeInstanceOf(
          StackLifecycleConflictError,
        );
        expect((yield* f.engine.status(f.database.id)).phase).toBe("ready");
        const sleepingRest = yield* f.engine
          .sleep(rest.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.enteredStop);
        yield* Deferred.succeed(f.releaseStop, undefined);
        yield* Fiber.join(sleepingRest);
        expect((yield* f.engine.status(rest.id)).phase).toBe("dormant");
        expect((yield* f.engine.sleep(f.database.id)).phase).toBe("dormant");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("protects a dependency while a dependent setup is admitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false);
        const rest = yield* compileServiceInstance(
          {
            service: "rest",
            name: "blocked-dependent-rest",
            config: { activation: "lazy" },
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        yield* f.engine.create(rest.instance, rest.secretSlots);
        yield* Ref.set(f.pauseDependentStart, true);
        yield* Deferred.succeed(f.releaseStart, undefined);
        const starting = yield* f.engine.start(rest.id).pipe(Effect.forkChild);
        yield* Deferred.await(f.enteredDependentStart);
        expect(yield* f.engine.sleep(f.database.id).pipe(Effect.flip)).toBeInstanceOf(
          StackLifecycleConflictError,
        );
        yield* Deferred.succeed(f.releaseDependentStart, undefined);
        expect((yield* Fiber.join(starting)).phase).toBe("ready");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("releases earlier dependency leases when a later dependency is fenced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false, true);
        const rest = yield* compileServiceInstance(
          {
            service: "rest",
            name: "partial-lease-rest",
            config: { activation: "lazy" },
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        const analytics = yield* compileServiceInstance(
          {
            service: "analytics",
            name: "partial-lease-analytics",
            config: { activation: "lazy" },
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        const studio = yield* compileServiceInstance(
          {
            service: "studio",
            name: "partial-lease-studio",
            config: { activation: "lazy" },
            dependencies: { database: f.database.id, rest: rest.id, analytics: analytics.id },
          },
          f.context,
        );
        yield* f.engine.create(rest.instance, rest.secretSlots);
        yield* f.engine.create(analytics.instance, analytics.secretSlots);
        yield* f.engine.create(
          { ...studio.instance, intent: "stopped" as const },
          studio.secretSlots,
        );
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.start(rest.id);
        yield* f.engine.start(analytics.id);
        const stopping = yield* f.engine.stop(rest.id).pipe(Effect.forkChild);
        yield* Deferred.await(f.enteredStop);
        yield* Ref.set(f.pauseStudioAdmission, true);
        const starting = yield* f.engine.start(studio.id).pipe(Effect.forkChild);
        yield* Deferred.await(f.admittedStudio);
        yield* Deferred.succeed(f.releaseStudioAdmission, undefined);
        yield* Deferred.succeed(f.releaseStop, undefined);
        yield* Fiber.join(stopping);
        expect((yield* f.engine.status(rest.id)).phase).toBe("stopped");
        expect(Exit.isFailure(yield* Fiber.join(starting).pipe(Effect.exit))).toBe(true);
        yield* f.engine.sleep(analytics.id);
        expect((yield* f.engine.sleep(f.database.id)).phase).toBe("dormant");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("replans endpoint assignments when a targeted restart changes intent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(false);
        const shadow = yield* compileServiceInstance(
          {
            service: "database",
            name: "restart-endpoint-shadow",
            config: { endpoints: { sql: { port: "auto" } } },
          },
          f.context,
        );
        yield* f.engine.create(shadow.instance, shadow.secretSlots);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.start(shadow.id);
        const before = yield* f.store.read(f.stackId);
        expect(
          before?.ports.some(
            (assignment) => assignment.owner === "instance" && assignment.instanceId === shadow.id,
          ),
        ).toBe(true);
        if (before === undefined)
          return yield* new StackLifecycleConflictError({ message: "state was not persisted" });
        const currentShadow = before.registry.instances.find(
          (instance) => instance.id === shadow.id,
        );
        if (currentShadow === undefined)
          return yield* new StackLifecycleConflictError({ message: "shadow was not persisted" });
        const replacement = yield* compileServiceRestart(
          currentShadow,
          { endpoints: { sql: { enabled: false } } },
          f.context,
        );
        yield* f.engine.restart(shadow.id, {
          ...replacement,
          previous: { state: before, instance: currentShadow },
        });
        const after = yield* f.store.read(f.stackId);
        expect(
          after?.ports.some(
            (assignment) => assignment.owner === "instance" && assignment.instanceId === shadow.id,
          ),
        ).toBe(false);
        expect(
          after?.registry.instances.find((instance) => instance.id === shadow.id),
        ).toMatchObject({ config: { endpoints: { sql: { enabled: false } } } });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects an active batch sleep before stopping any selected instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.startAll([f.database.id, f.functions.id]);
        yield* Ref.set(f.active, new Set([f.database.id]));
        expect(
          yield* f.engine.sleepAll([f.database.id, f.functions.id]).pipe(Effect.flip),
        ).toBeInstanceOf(StackLifecycleConflictError);
        expect((yield* f.engine.status(f.database.id)).phase).toBe("ready");
        expect((yield* f.engine.status(f.functions.id)).phase).toBe("ready");
        expect(yield* Ref.get(f.ready)).toEqual(new Set([f.database.id, f.functions.id]));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("admits lazy Functions on whole start and makes explicit selections ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const rest = yield* compileServiceInstance(
          {
            service: "rest",
            name: "whole-start-rest",
            config: { activation: "lazy" },
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        const analytics = yield* compileServiceInstance(
          {
            service: "analytics",
            name: "whole-start-analytics",
            config: { activation: "lazy" },
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        const studio = yield* compileServiceInstance(
          {
            service: "studio",
            name: "whole-start-studio",
            config: { activation: "lazy", endpoints: { studio: { port: "auto" } } },
            dependencies: { database: f.database.id, rest: rest.id, analytics: analytics.id },
          },
          f.context,
        );
        const pooler = yield* compileServiceInstance(
          {
            service: "pooler",
            name: "whole-start-pooler",
            config: { activation: "lazy", endpoints: { pooler: { port: "auto" } } },
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        yield* f.engine.create(rest.instance, rest.secretSlots);
        yield* f.engine.create(analytics.instance, analytics.secretSlots);
        yield* f.engine.create(studio.instance, studio.secretSlots);
        yield* f.engine.create(pooler.instance, pooler.secretSlots);
        yield* Deferred.succeed(f.releaseStart, undefined);
        yield* f.engine.startAll();
        expect(yield* Ref.get(f.starts)).toEqual([f.database.id]);
        const persisted = yield* f.store.read(f.stackId);
        expect(
          persisted?.ports.filter(
            (entry) => entry.owner === "instance" && entry.instanceId === studio.id,
          ),
        ).toEqual([expect.objectContaining({ binding: "studio", intent: "automatic" })]);
        expect(
          persisted?.ports.filter(
            (entry) => entry.owner === "instance" && entry.instanceId === pooler.id,
          ),
        ).toEqual([expect.objectContaining({ binding: "pooler", intent: "automatic" })]);
        expect(yield* f.engine.status(f.functions.id)).toMatchObject({
          intent: "started",
          phase: "dormant",
          activation: "lazy",
        });
        yield* f.engine.startAll([f.functions.id]);
        expect((yield* f.engine.status(f.functions.id)).phase).toBe("ready");
        expect(yield* Ref.get(f.starts)).toEqual([f.database.id, f.functions.id]);
        yield* f.engine.startAll();
        expect((yield* f.engine.status(f.functions.id)).phase).toBe("ready");
        expect(yield* Ref.get(f.starts)).toEqual([f.database.id, f.functions.id]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("completes a paused status subscriber after its instance has been destroyed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const subscribed = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const observing = yield* f.engine.followStatus(f.database.id).pipe(
          Stream.tap(() =>
            Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(Deferred.await(resume))),
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        yield* f.engine.destroy(f.database.id);
        expect((yield* f.engine.list).some(({ id }) => id === f.database.id)).toBe(false);
        yield* Deferred.succeed(resume, undefined);
        const statuses = yield* Fiber.join(observing);
        expect(statuses[0]?.id).toBe(f.database.id);
        expect((yield* f.engine.describe({ id: f.functions.id })).id).toBe(f.functions.id);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains a new registration's ports when another start resumes after admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeFixture(true);
        yield* Deferred.succeed(f.releaseStart, undefined);
        const starting = yield* f.engine.start(f.database.id).pipe(Effect.forkChild);
        yield* Deferred.await(f.admittedStart);
        const second = yield* compileServiceInstance(
          {
            service: "database",
            name: "concurrent-shadow",
            config: { endpoints: { sql: { port: "auto" } } },
          },
          f.context,
        );
        yield* f.engine.create(second.instance, second.secretSlots);
        const registered = yield* f.store.read(f.stackId);
        const publicPorts = registered?.ports.filter(
          (entry) => entry.owner === "instance" && entry.instanceId === second.id,
        );
        const privatePorts = registered?.privatePorts.filter(
          ({ instanceId }) => instanceId === second.id,
        );
        expect(publicPorts).toHaveLength(1);
        expect(privatePorts).toHaveLength(1);
        yield* Deferred.succeed(f.releaseAdmission, undefined);
        expect((yield* Fiber.join(starting)).phase).toBe("ready");
        const settled = yield* f.store.read(f.stackId);
        expect(
          settled?.ports.filter(
            (entry) => entry.owner === "instance" && entry.instanceId === second.id,
          ),
        ).toEqual(publicPorts);
        expect(settled?.privatePorts.filter(({ instanceId }) => instanceId === second.id)).toEqual(
          privatePorts,
        );
        expect((yield* f.engine.describe({ id: second.id })).name).toBe("concurrent-shadow");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "rejects database destruction before cleanup when a stopped dependent is registered",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* Deferred.succeed(f.releaseStart, undefined);
          yield* f.engine.start(f.database.id);
          const dependent = yield* compileServiceInstance(
            {
              service: "rest",
              name: "retained-rest",
              config: {},
              dependencies: { database: f.database.id },
            },
            f.context,
          );
          yield* f.engine.create(dependent.instance, dependent.secretSlots);
          const before = yield* f.store.read(f.stackId);
          const result = yield* f.engine.destroy(f.database.id).pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          expect((yield* Ref.get(f.ready)).has(f.database.id)).toBe(true);
          expect(yield* f.store.read(f.stackId)).toEqual(before);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("destroys disabled dependents before their registered database", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const disabled = yield* compileServiceInstance(
          { service: "database", name: "disabled-database", config: { enabled: false } },
          f.context,
        );
        yield* f.engine.create(disabled.instance, disabled.secretSlots);
        const dependent = yield* compileServiceInstance(
          {
            service: "rest",
            name: "disabled-rest",
            config: { enabled: false },
            dependencies: { database: disabled.id },
          },
          f.context,
        );
        yield* f.engine.create(dependent.instance, dependent.secretSlots);
        expect((yield* f.engine.list).map(({ id }) => id)).toContain(disabled.id);
        expect((yield* f.engine.describe({ id: dependent.id })).dependencies.database).toBe(
          disabled.id,
        );
        yield* f.engine.destroyAll();
        expect(yield* f.engine.list).toEqual([]);
        const saved = yield* f.store.read(f.stackId);
        expect(saved?.registry.instances).toEqual([]);
        expect(saved?.ports).toEqual([]);
        expect(saved?.privatePorts).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps one shared dependency start when a dependent caller abandons its wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const rest = yield* compileServiceInstance(
          { service: "rest", name: "rest", config: {}, dependencies: { database: f.database.id } },
          f.context,
        );
        const storage = yield* compileServiceInstance(
          {
            service: "storage",
            name: "storage",
            config: {},
            dependencies: { database: f.database.id },
          },
          f.context,
        );
        yield* f.engine.create(rest.instance, rest.secretSlots);
        yield* f.engine.create(storage.instance, storage.secretSlots);
        const abandoned = yield* f.engine.start(rest.id).pipe(Effect.forkChild);
        yield* Deferred.await(f.enteredStart);
        const surviving = yield* f.engine.start(storage.id).pipe(Effect.forkChild);
        yield* Fiber.interrupt(abandoned);
        expect((yield* f.engine.status(f.database.id)).pendingOperation?.kind).toBe("start");
        yield* Deferred.succeed(f.releaseStart, undefined);
        expect((yield* Fiber.join(surviving)).phase).toBe("ready");
        expect((yield* Ref.get(f.starts)).filter((id) => id === f.database.id)).toHaveLength(1);
        expect((yield* Ref.get(f.ready)).has(f.database.id)).toBe(true);
        expect((yield* f.engine.status(f.database.id)).phase).toBe("ready");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "finishes a Functions restart while shadow initialization outlives its first waiter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.engine.start(f.functions.id);
          const abandoned = yield* f.engine.start(f.database.id).pipe(Effect.forkChild);
          yield* Deferred.await(f.enteredStart);
          yield* Fiber.interrupt(abandoned);
          const joined = yield* f.engine.start(f.database.id).pipe(Effect.forkChild);
          expect((yield* f.engine.restart(f.functions.id)).phase).toBe("ready");
          expect((yield* Ref.get(f.ready)).has(f.functions.id)).toBe(true);
          expect((yield* f.engine.status(f.database.id)).pendingOperation?.kind).toBe("start");
          yield* Deferred.succeed(f.releaseStart, undefined);
          expect((yield* Fiber.join(joined)).phase).toBe("ready");
          expect((yield* Ref.get(f.starts)).filter((id) => id === f.database.id)).toHaveLength(1);
          const saved = yield* f.store.read(f.stackId);
          expect(
            saved?.registry.instances.map(({ intent, pendingOperation }) => ({
              intent,
              pendingOperation,
            })),
          ).toEqual([
            { intent: "started", pendingOperation: null },
            { intent: "started", pendingOperation: null },
          ]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "restarts Functions while a stopped shadow exports and rejects conflicting shadow starts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* Deferred.succeed(f.releaseStart, undefined);
          yield* Effect.all([f.engine.start(f.database.id), f.engine.start(f.functions.id)], {
            concurrency: "unbounded",
          });
          yield* f.engine.stop(f.database.id);
          const exporting = yield* f.engine
            .exportSnapshot(f.database.id, "/unused-test-destination")
            .pipe(Effect.forkChild);
          yield* Deferred.await(f.enteredExport);
          expect((yield* f.engine.restart(f.functions.id)).phase).toBe("ready");
          expect(yield* f.engine.start(f.database.id).pipe(Effect.flip)).toBeInstanceOf(
            StackLifecycleConflictError,
          );
          expect((yield* f.engine.status(f.database.id)).pendingOperation?.kind).toBe(
            "exportSnapshot",
          );
          yield* Deferred.succeed(f.releaseExport, undefined);
          expect((yield* Fiber.join(exporting)).provenance.sourceInstanceId).toBe(f.database.id);
          const saved = yield* f.store.read(f.stackId);
          expect(saved?.registry.instances.find(({ id }) => id === f.database.id)?.intent).toBe(
            "stopped",
          );
          expect(saved?.registry.instances.find(({ id }) => id === f.functions.id)?.intent).toBe(
            "started",
          );
          expect(
            saved?.registry.instances.every(({ pendingOperation }) => pendingOperation === null),
          ).toBe(true);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
