import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Crypto,
  Deferred,
  Exit,
  Effect,
  FileSystem,
  Fiber,
  Path,
  Redacted,
  Scope,
  Stream,
} from "effect";
import { makeInstanceEngine } from "./InstanceEngine.ts";
import type { InstanceRuntimeInput } from "./Lifecycle.ts";
import type { SupervisorRuntime } from "./Supervisor.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import type {
  PersistedPendingOperation,
  PersistedServiceInstance,
} from "../model/ServiceRegistry.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import type { RuntimeDriver } from "../runtime/RuntimeDriver.ts";
import { ServiceInstanceIdSchema, type ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import { StackLifecycleConflictError } from "../public/Errors.ts";
import type { SnapshotDescriptor } from "../public/Service.ts";
import type { StackError } from "../public/Errors.ts";
import { deriveStackId } from "../identity/Identity.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import type { LogStore } from "./LogStore.ts";

const noOpIngress: SupervisorIngress = { close: Effect.void };

const noOpLogStore: LogStore = {
  path: "/dev/null",
  append: () => Effect.die("instance-engine test does not write logs"),
  read: () => Effect.succeed([]),
};

const instance = (
  id: ServiceInstanceId,
  name: string,
  enabled = true,
): PersistedServiceInstance => ({
  id,
  service: "database",
  name,
  intent: "stopped",
  config: {
    enabled,
    activation: "eager",
    idleTimeoutSeconds: false,
    version: "17.6.1.168",
    settings: {
      health_timeout: "2m",
      settings: {
        effective_cache_size: null,
        logical_decoding_work_mem: null,
        maintenance_work_mem: null,
        max_connections: null,
        max_locks_per_transaction: null,
        max_parallel_maintenance_workers: null,
        max_parallel_workers: null,
        max_parallel_workers_per_gather: null,
        max_replication_slots: null,
        max_slot_wal_keep_size: null,
        max_standby_archive_delay: null,
        max_standby_streaming_delay: null,
        max_wal_size: null,
        max_wal_senders: null,
        max_worker_processes: null,
        session_replication_role: null,
        shared_buffers: null,
        statement_timeout: null,
        track_activity_query_size: null,
        track_commit_timestamp: null,
        wal_keep_size: null,
        wal_sender_timeout: null,
        work_mem: null,
      },
    },
    endpoints: {},
  },
  dependencies: {},
  resources: {},
  revisions: { config: 0, intent: 0 },
  pendingOperation: null,
  initialization: null,
  initializationInputs: null,
  data: { origin: "absent" },
});

const state = (
  projectRoot: string,
  first: PersistedServiceInstance,
  second: PersistedServiceInstance,
  secrets: PersistedStackState["secrets"] = {
    "test-jwt": { policy: "managed", value: "test-jwt-secret" },
  },
): PersistedStackState => ({
  format: "supabase-stack-state-v2",
  identity: { projectRoot, branchContext: "test", stackName: "engine" },
  runtime: { kind: "native" },
  preparation: "on-demand",
  security: {
    jwt: {
      issuer: null,
      expirySeconds: 3600,
      signing: { kind: "symmetric", secret: { slot: "test-jwt" } },
    },
  },
  listeners: {},
  registry: {
    initialized: true,
    instances: [first, second],
    defaultInstanceIds: { database: first.id },
  },
  ports: [],
  privatePorts: [],
  secrets,
});

interface Fixture {
  readonly context: Context.Context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>;
  readonly engine: import("./InstanceEngine.ts").InstanceEngine;
  readonly store: StackStateStore;
  readonly stackId: string;
  readonly first: PersistedServiceInstance;
  readonly second: PersistedServiceInstance;
  readonly read: () => Effect.Effect<PersistedStackState | undefined, unknown>;
}

interface RuntimeHooks {
  readonly start?: (
    input: InstanceRuntimeInput,
  ) => Effect.Effect<ReadonlyArray<RuntimeBindingPublication>, StackError>;
  readonly stop?: (input: InstanceRuntimeInput) => Effect.Effect<void, StackError>;
  readonly destroy?: (input: InstanceRuntimeInput) => Effect.Effect<void, StackError>;
  readonly recoverSnapshot?: (
    input: InstanceRuntimeInput,
    operation: PersistedPendingOperation,
  ) => Effect.Effect<SnapshotDescriptor | undefined, StackError>;
}

const runtimeFor = (hooks: RuntimeHooks = {}): SupervisorRuntime => {
  const driver: RuntimeDriver = {
    observe: () => Effect.succeed([]),
    start: () => Effect.die("instance-engine test does not start driver workloads"),
    stop: () => Effect.die("instance-engine test does not stop driver workloads"),
    remove: () => Effect.die("instance-engine test does not remove driver workloads"),
    cleanup: () => Effect.die("instance-engine test does not clean driver workloads"),
    wipePersistentData: () => Effect.die("instance-engine test does not wipe driver workloads"),
  };
  const unsupportedSnapshot = (): Effect.Effect<SnapshotDescriptor, StackError> =>
    Effect.fail(new StackLifecycleConflictError({ message: "snapshot is outside this test" }));
  return {
    driver,
    preflight: () => Effect.void,
    prepare: () => Effect.succeed({ instances: [] }),
    prepareArtifacts: () => Effect.void,
    start: hooks.start ?? (() => Effect.succeed([])),
    stop: hooks.stop ?? (() => Effect.void),
    destroy: hooks.destroy ?? (() => Effect.void),
    exportSnapshot: unsupportedSnapshot,
    restoreSnapshot: unsupportedSnapshot,
    ...(hooks.recoverSnapshot === undefined ? {} : { recoverSnapshot: hooks.recoverSnapshot }),
    prefetch: () => Effect.void,
    artifacts: Effect.succeed([]),
    activate: () => Effect.die("instance-engine test does not activate gateways"),
    ingress: noOpIngress,
    logStore: noOpLogStore,
  };
};

const makeFixture = (
  first: PersistedServiceInstance,
  second: PersistedServiceInstance,
  secrets?: PersistedStackState["secrets"],
  hooks?: RuntimeHooks,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-instance-engine-" });
    const projectRoot = path.join(root, "project");
    yield* fs.makeDirectory(projectRoot);
    const identity = { projectRoot, branchContext: "test", stackName: "engine" } as const;
    const stackId = yield* deriveStackId(identity);
    const context = Context.make(FileSystem.FileSystem, fs).pipe(
      Context.add(Path.Path, path),
      Context.add(Crypto.Crypto, crypto),
    );
    const store = yield* makeStackStateStore({ stateRoot: path.join(root, "state") });
    yield* store
      .initialize(stackId, state(projectRoot, first, second, secrets))
      .pipe(Effect.provideContext(context));
    const engine = yield* makeInstanceEngine({
      stackId,
      ownerSessionId: "owner",
      stateStore: store,
      runtime: runtimeFor(hooks),
      scope: yield* Scope.Scope,
      context,
    });
    return {
      context,
      engine,
      store,
      stackId,
      first,
      second,
      read: () => store.read(stackId).pipe(Effect.provideContext(context)),
    } satisfies Fixture;
  });

const id = (value: string): ServiceInstanceId => ServiceInstanceIdSchema.make(value);

describe("instance engine", () => {
  it.live("starts independent instances while one runtime operation is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = instance(id("00000000-0000-4000-8000-000000000001"), "primary");
        const second = instance(id("00000000-0000-4000-8000-000000000002"), "shadow");
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        let startCalls = 0;
        const f = yield* makeFixture(first, second, undefined, {
          start: (input) =>
            Effect.gen(function* () {
              startCalls += 1;
              if (input.instance.id === first.id) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              } else yield* Deferred.succeed(secondStarted, undefined);
              return [];
            }),
        });
        const firstFiber = yield* Effect.forkChild(f.engine.start(first.id), {
          startImmediately: true,
        });
        yield* Deferred.await(firstStarted);
        const secondFiber = yield* Effect.forkChild(f.engine.start(second.id), {
          startImmediately: true,
        });
        yield* Deferred.await(secondStarted);
        expect((yield* Fiber.join(secondFiber)).phase).toBe("ready");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(firstFiber);
        expect((yield* f.engine.start(second.id)).phase).toBe("ready");
        expect(startCalls).toBe(2);
        yield* f.engine.destroy(first.id);
        expect(
          (yield* f.read())?.registry.instances.map(({ id: instanceId }) => instanceId),
        ).toEqual([second.id]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("lets stop supersede and cancel an in-flight start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = instance(id("00000000-0000-4000-8000-000000000041"), "cancel-start");
        const second = instance(id("00000000-0000-4000-8000-000000000042"), "other");
        const entered = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const never = yield* Deferred.make<void>();
        const f = yield* makeFixture(first, second, undefined, {
          start: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(never)),
              Effect.andThen(Effect.succeed([])),
            ),
          stop: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        });
        const starting = yield* Effect.forkChild(f.engine.start(first.id), {
          startImmediately: true,
        });
        yield* Deferred.await(entered);
        const stopping = yield* Effect.forkChild(f.engine.stop(first.id), {
          startImmediately: true,
        });
        yield* Deferred.await(stopped);
        expect((yield* Fiber.join(stopping)).phase).toBe("stopped");
        expect(Exit.isFailure(yield* Fiber.join(starting).pipe(Effect.exit))).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects starting a disabled instance before invoking its runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = instance(id("00000000-0000-4000-8000-000000000051"), "disabled", false);
        const second = instance(id("00000000-0000-4000-8000-000000000052"), "other");
        let starts = 0;
        const f = yield* makeFixture(first, second, undefined, {
          start: () =>
            Effect.sync(() => {
              starts += 1;
              return [];
            }),
        });
        expect(Exit.isFailure(yield* f.engine.start(first.id).pipe(Effect.exit))).toBe(true);
        expect(starts).toBe(0);
        expect((yield* f.engine.status(first.id)).intent).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports mail listener bindings as TCP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = instance(id("00000000-0000-4000-8000-000000000055"), "mail-endpoints");
        const second = instance(id("00000000-0000-4000-8000-000000000056"), "other");
        const f = yield* makeFixture(first, second);
        yield* f.store
          .update(f.stackId, (current) =>
            Effect.succeed({
              ...current,
              ports: [
                {
                  owner: "instance" as const,
                  instanceId: first.id,
                  binding: "smtp",
                  address: "127.0.0.1",
                  port: 2525,
                  intent: "exact" as const,
                },
                {
                  owner: "instance" as const,
                  instanceId: first.id,
                  binding: "pop3",
                  address: "127.0.0.1",
                  port: 2110,
                  intent: "exact" as const,
                },
              ],
            }),
          )
          .pipe(Effect.provideContext(f.context));

        const descriptor = (yield* f.engine.list).find(
          ({ id: instanceId }) => instanceId === first.id,
        );
        expect(descriptor?.endpoints.smtp).toMatchObject({
          protocol: "tcp",
          url: "tcp://127.0.0.1:2525",
        });
        expect(descriptor?.endpoints.pop3).toMatchObject({
          protocol: "tcp",
          url: "tcp://127.0.0.1:2110",
        });
        const status = yield* f.engine.status(first.id);
        expect(status.endpoints).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ binding: "smtp", protocol: "tcp" }),
            expect.objectContaining({ binding: "pop3", protocol: "tcp" }),
          ]),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains a redacted startup failure per instance until retry succeeds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = instance(id("00000000-0000-4000-8000-000000000057"), "failed-start");
        const second = instance(id("00000000-0000-4000-8000-000000000058"), "healthy-start");
        let failFirst = true;
        const f = yield* makeFixture(first, second, undefined, {
          start: (input) =>
            input.instance.id === first.id && failFirst
              ? Effect.fail(
                  new StackLifecycleConflictError({
                    message: "startup failed with test-jwt-secret",
                  }),
                )
              : Effect.succeed([]),
        });

        expect(Exit.isFailure(yield* f.engine.start(first.id).pipe(Effect.exit))).toBe(true);
        const failed = yield* f.engine.status(first.id);
        expect(failed.phase).toBe("failed");
        expect(failed.error).toMatchObject({
          tag: "StackLifecycleConflictError",
          message: "startup failed with [REDACTED]",
          instanceId: first.id,
        });
        expect(failed.error?.operationId).toEqual(expect.any(String));
        expect((yield* f.engine.start(second.id)).phase).toBe("ready");

        failFirst = false;
        expect((yield* f.engine.start(first.id)).phase).toBe("ready");
        expect((yield* f.engine.status(first.id)).error).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fences only the instance whose recovery cleanup failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = instance(id("00000000-0000-4000-8000-000000000061"), "broken-recovery");
        const second = instance(id("00000000-0000-4000-8000-000000000062"), "healthy");
        const f = yield* makeFixture(first, second, undefined, {
          stop: () =>
            Effect.fail(new StackLifecycleConflictError({ message: "cleanup unavailable" })),
        });
        yield* f.store
          .update(f.stackId, (current): Effect.Effect<PersistedStackState, never> =>
            Effect.succeed({
              ...current,
              registry: {
                ...current.registry,
                instances: current.registry.instances.map((entry) =>
                  entry.id === first.id
                    ? {
                        ...entry,
                        intent: "started" as const,
                        pendingOperation: {
                          id: "recovery-stop",
                          kind: "stop" as const,
                          generation: 1,
                          ownerSessionId: "crashed-owner",
                          phase: "running" as const,
                        },
                      }
                    : entry,
                ),
              },
            }),
          )
          .pipe(Effect.provideContext(f.context));
        expect(Exit.isSuccess(yield* f.engine.recover.pipe(Effect.exit))).toBe(true);
        expect((yield* f.engine.status(first.id)).phase).toBe("recovery");
        expect((yield* f.engine.status(first.id)).recovery?.operation).toBe("stop");
        expect((yield* f.engine.status(second.id)).phase).toBe("stopped");
        expect(Exit.isFailure(yield* f.engine.start(first.id).pipe(Effect.exit))).toBe(true);
        yield* f.engine.destroy(first.id);
        expect((yield* f.engine.list).some(({ id: currentId }) => currentId === first.id)).toBe(
          false,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps an unresolved restore fenced until destroy cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = instance(id("00000000-0000-4000-8000-000000000071"), "broken-restore");
        const second = instance(id("00000000-0000-4000-8000-000000000072"), "healthy");
        const f = yield* makeFixture(first, second, undefined, {
          recoverSnapshot: () =>
            Effect.fail(new StackLifecycleConflictError({ message: "restore manifest missing" })),
        });
        yield* f.store
          .update(f.stackId, (current): Effect.Effect<PersistedStackState, never> =>
            Effect.succeed({
              ...current,
              registry: {
                ...current.registry,
                instances: current.registry.instances.map((entry) =>
                  entry.id === first.id
                    ? {
                        ...entry,
                        intent: "started" as const,
                        data: {
                          origin: "incomplete" as const,
                          operationId: "restore-operation",
                        },
                        pendingOperation: {
                          id: "restore-operation",
                          kind: "restoreSnapshot" as const,
                          generation: 1,
                          ownerSessionId: "crashed-owner",
                          phase: "complete" as const,
                        },
                      }
                    : entry,
                ),
              },
            }),
          )
          .pipe(Effect.provideContext(f.context));
        expect(Exit.isSuccess(yield* f.engine.recover.pipe(Effect.exit))).toBe(true);
        expect((yield* f.engine.status(first.id)).recovery?.operation).toBe("destroy");
        const stopped = yield* f.engine.stop(first.id).pipe(Effect.exit);
        expect(Exit.isFailure(stopped)).toBe(true);
        expect(
          (yield* f.read())?.registry.instances.find((entry) => entry.id === first.id)
            ?.pendingOperation,
        ).toMatchObject({ kind: "restoreSnapshot", id: "restore-operation" });
        yield* f.engine.destroy(first.id);
        expect((yield* f.engine.list).some(({ id: currentId }) => currentId === first.id)).toBe(
          false,
        );
        expect((yield* f.engine.status(second.id)).phase).toBe("stopped");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("preserves secrets owned by existing instances when registering a new one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = instance(id("00000000-0000-4000-8000-000000000011"), "secret-primary");
        const second = instance(id("00000000-0000-4000-8000-000000000012"), "secret-shadow");
        const third = instance(id("00000000-0000-4000-8000-000000000013"), "secret-new");
        const f = yield* makeFixture(first, second, {
          [`secret:${first.id}:password`]: { policy: "managed", value: "first-password" },
          [`secret:${second.id}:password`]: { policy: "managed", value: "second-password" },
          "secret:functions.env.API_KEY": { policy: "passthrough", value: "functions-key" },
        });
        yield* f.engine.create(third, [
          {
            slot: `secret:${third.id}:password`,
            policy: "managed",
            value: Redacted.make("third-password"),
          },
        ]);
        const persisted = yield* f.read();
        expect(persisted?.secrets[`secret:${first.id}:password`]?.value).toBe("first-password");
        expect(persisted?.secrets[`secret:${second.id}:password`]?.value).toBe("second-password");
        expect(persisted?.secrets["secret:functions.env.API_KEY"]?.value).toBe("functions-key");
        expect(persisted?.secrets[`secret:${third.id}:password`]?.value).toBe("third-password");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("subscribes before the initial service status read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = instance(id("00000000-0000-4000-8000-000000000021"), "follow");
        const second = instance(id("00000000-0000-4000-8000-000000000022"), "other");
        const f = yield* makeFixture(first, second);
        const subscribed = yield* Deferred.make<void>();
        const observed = yield* f.engine.followStatus(first.id).pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        yield* f.engine.start(first.id);
        const statuses = yield* Fiber.join(observed);
        expect(statuses[0]?.phase).toBe("stopped");
        expect(statuses.some(({ phase }) => phase === "ready")).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("completes a status stream after its instance is destroyed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = instance(id("00000000-0000-4000-8000-000000000031"), "destroy-follow");
        const second = instance(id("00000000-0000-4000-8000-000000000032"), "other");
        const f = yield* makeFixture(first, second);
        const subscribed = yield* Deferred.make<void>();
        const observing = yield* f.engine.followStatus(first.id).pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        yield* f.engine.destroy(first.id);
        expect((yield* f.engine.list).some(({ id: instanceId }) => instanceId === first.id)).toBe(
          false,
        );
        const statuses = yield* Fiber.join(observing);
        expect(statuses[0]?.id).toBe(first.id);
        expect((yield* f.engine.describe({ id: second.id })).id).toBe(second.id);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
