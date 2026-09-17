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
import { compileServiceInstance } from "../model/Compiler.ts";
import type { SnapshotDescriptor } from "../public/Service.ts";
import type { ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import { StackLifecycleConflictError } from "../public/Errors.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { AUTH_JWT_SECRET_SLOT } from "../state/SecretStore.ts";
import { makeInstanceEngine } from "./InstanceEngine.ts";
import type { SupervisorRuntime } from "./Supervisor.ts";
import type { InstanceRuntimeInput } from "./Lifecycle.ts";

const makeFixture = (pauseAfterStartAdmission = false, pauseFirstStop = false) =>
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
    const enteredExport = yield* Deferred.make<void>();
    const releaseExport = yield* Deferred.make<void>();
    const admittedStart = yield* Deferred.make<void>();
    const releaseAdmission = yield* Deferred.make<void>();
    const admissionPaused = yield* Ref.make(false);
    const ready = yield* Ref.make<ReadonlySet<ServiceInstanceId>>(new Set());
    const active = yield* Ref.make<ReadonlySet<ServiceInstanceId>>(new Set());
    const starts = yield* Ref.make<ReadonlyArray<ServiceInstanceId>>([]);
    const enteredStop = yield* Deferred.make<ServiceInstanceId>();
    const releaseStop = yield* Deferred.make<void>();
    const stopPaused = yield* Ref.make(false);
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
          yield* Ref.update(ready, (ids) => new Set(ids).add(input.instance.id));
          return [];
        }),
      stop: (input) =>
        Effect.gen(function* () {
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
        Ref.update(ready, (ids) => new Set([...ids].filter((id) => id !== input.instance.id))),
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
          Effect.tap((saved) =>
            Effect.gen(function* () {
              if (
                !pauseAfterStartAdmission ||
                !saved.registry.instances.some(
                  (instance) =>
                    instance.id === database.id && instance.pendingOperation?.kind === "start",
                )
              )
                return;
              if (yield* Ref.getAndSet(admissionPaused, true)) return;
              yield* Deferred.succeed(admittedStart, undefined);
              yield* Deferred.await(releaseAdmission);
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
      enteredStart,
      releaseStart,
      enteredExport,
      releaseExport,
      admittedStart,
      releaseAdmission,
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

  it.live("admits startup control only for its own lifecycle claim", () =>
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
        const ordinary = yield* f.engine.acquireTraffic(f.database.id).pipe(Effect.exit);
        expect(Exit.isFailure(ordinary)).toBe(true);
        yield* startup.release;
        yield* Deferred.succeed(f.releaseAdmission, undefined);
        yield* Deferred.succeed(f.releaseStart, undefined);
        expect((yield* Fiber.join(starting)).phase).toBe("ready");

        const ready = yield* f.engine.acquireTraffic(f.database.id, "startup-control");
        yield* ready.release;

        const stopping = yield* f.engine
          .stop(f.database.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.enteredStop);
        const duringStop = yield* f.engine
          .acquireTraffic(f.database.id, "startup-control")
          .pipe(Effect.exit);
        expect(Exit.isFailure(duringStop)).toBe(true);
        yield* Deferred.succeed(f.releaseStop, undefined);
        expect((yield* Fiber.join(stopping)).phase).toBe("stopped");
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
        yield* f.engine.destroy(f.database.id);
        yield* f.engine.startAll();
        expect(yield* Ref.get(f.starts)).toEqual([]);
        expect(yield* f.engine.status(f.functions.id)).toMatchObject({
          intent: "started",
          phase: "dormant",
          activation: "lazy",
        });
        yield* f.engine.startAll([f.functions.id]);
        expect((yield* f.engine.status(f.functions.id)).phase).toBe("ready");
        expect(yield* Ref.get(f.starts)).toEqual([f.functions.id]);
        yield* f.engine.startAll();
        expect((yield* f.engine.status(f.functions.id)).phase).toBe("ready");
        expect(yield* Ref.get(f.starts)).toEqual([f.functions.id]);
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
