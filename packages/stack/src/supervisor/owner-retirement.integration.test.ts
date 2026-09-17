import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Ref,
} from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { compileServiceInstance } from "../model/Compiler.ts";
import { deriveStackId } from "../identity/Identity.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import type { RuntimeDriver } from "../runtime/RuntimeDriver.ts";
import { makeControlClient, startControlServer } from "../control/ControlServer.ts";
import { STACK_RPC_RELEASE, type StackRpcHandlers } from "../control/StackRpc.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makeStackStateStore, type StackStateStore } from "../state/StackStateStore.ts";
import { ServiceInstanceIdSchema, type ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import { StackLifecycleConflictError } from "../public/Errors.ts";
import type { SupervisorRuntime, Supervisor } from "./Supervisor.ts";
import { makeSupervisor } from "./Supervisor.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import type { LogStore } from "./LogStore.ts";

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const ingress: SupervisorIngress = {
  acquire: () => Effect.die("owner-retirement test does not open public ingress"),
  open: () => Effect.die("owner-retirement test does not open public ingress"),
  close: Effect.void,
};

const logStore: LogStore = {
  path: "/dev/null",
  append: () => Effect.die("owner-retirement test does not write logs"),
  read: () => Effect.succeed([]),
};

const stateFor = (
  projectRoot: string,
  instance: PersistedStackState["registry"]["instances"][number],
): PersistedStackState => ({
  format: "supabase-stack-state-v2",
  identity: { projectRoot, branchContext: "test", stackName: "owner-retirement" },
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
    instances: [instance],
    defaultInstanceIds: { database: instance.id },
  },
  ports: [],
  privatePorts: [],
  secrets: { "test-jwt": { policy: "managed", value: "test-jwt" } },
});

interface Fixture {
  readonly stackId: string;
  readonly ownerSessionId: string;
  readonly endpoint: { readonly kind: "unix"; readonly path: string };
  readonly supervisor: Supervisor;
  readonly stateStore: StackStateStore;
  readonly instanceId: ServiceInstanceId;
  readonly destroyFailure: Ref.Ref<boolean>;
  readonly destroyCalls: Ref.Ref<number>;
  readonly cleanupCalls: Ref.Ref<number>;
  readonly startEntered: Deferred.Deferred<void>;
  readonly startRelease: Deferred.Deferred<void>;
  readonly startCalls: Ref.Ref<number>;
  readonly shutdownRequested: Deferred.Deferred<void>;
  readonly prefaceAcquired: Deferred.Deferred<void>;
  readonly prefaceReleased: Deferred.Deferred<void>;
  readonly requestEntered: Deferred.Deferred<void>;
  readonly requestRelease: Deferred.Deferred<void>;
  readonly holdRequest: Ref.Ref<boolean>;
}

const withFixture = <A, E, R>(f: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  withPlatform(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-stack-owner-retirement-",
      });
      const projectRoot = path.join(root, "project");
      yield* fs.makeDirectory(projectRoot);
      const identity = {
        projectRoot,
        branchContext: "test",
        stackName: "owner-retirement",
      } as const;
      const stackId = yield* deriveStackId(identity);
      const instanceId = ServiceInstanceIdSchema.make("11111111-1111-4111-8111-111111111111");
      const context = Context.make(FileSystem.FileSystem, fs).pipe(
        Context.add(Path.Path, path),
        Context.add(Crypto.Crypto, crypto),
      );
      const compiled = yield* compileServiceInstance(
        { service: "database", config: {} },
        { projectRoot, path, runtime: { kind: "native" }, instanceId },
      ).pipe(Effect.provideContext(context));
      const stateStore = yield* makeStackStateStore({ stateRoot: path.join(root, "state") });
      yield* stateStore
        .initialize(stackId, stateFor(projectRoot, compiled.instance))
        .pipe(Effect.provideContext(context));
      const destroyFailure = yield* Ref.make(false);
      const destroyCalls = yield* Ref.make(0);
      const cleanupCalls = yield* Ref.make(0);
      const startEntered = yield* Deferred.make<void>();
      const startRelease = yield* Deferred.make<void>();
      const startCalls = yield* Ref.make(0);
      const shutdownRequested = yield* Deferred.make<void>();
      const prefaceAcquired = yield* Deferred.make<void>();
      const prefaceReleased = yield* Deferred.make<void>();
      const requestEntered = yield* Deferred.make<void>();
      const requestRelease = yield* Deferred.make<void>();
      const holdRequest = yield* Ref.make(false);
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed([]),
        start: () => Effect.die("owner-retirement test does not start workloads"),
        stop: () => Effect.die("owner-retirement test does not stop workloads"),
        remove: () => Effect.die("owner-retirement test does not remove workloads"),
        cleanup: () => Ref.update(cleanupCalls, (calls) => calls + 1),
        wipePersistentData: () => Effect.die("owner-retirement test does not wipe workloads"),
      };
      const runtime: SupervisorRuntime = {
        driver,
        preflight: () => Effect.void,
        prepare: () => Effect.succeed({ instances: [] }),
        prepareArtifacts: () => Effect.void,
        start: () =>
          Ref.update(startCalls, (calls) => calls + 1).pipe(
            Effect.andThen(Deferred.succeed(startEntered, undefined)),
            Effect.andThen(Deferred.await(startRelease)),
            Effect.andThen(Effect.succeed([] as ReadonlyArray<RuntimeBindingPublication>)),
          ),
        stop: () => Effect.void,
        destroy: () =>
          Ref.update(destroyCalls, (calls) => calls + 1).pipe(
            Effect.andThen(
              Ref.get(destroyFailure).pipe(
                Effect.flatMap((fail) =>
                  fail
                    ? Effect.fail(
                        new StackLifecycleConflictError({
                          stackId,
                          message: "test destroy is busy",
                        }),
                      )
                    : Effect.void,
                ),
              ),
            ),
          ),
        exportSnapshot: () =>
          Effect.fail(
            new StackLifecycleConflictError({ message: "snapshot is outside this test" }),
          ),
        restoreSnapshot: () =>
          Effect.fail(
            new StackLifecycleConflictError({ message: "snapshot is outside this test" }),
          ),
        prefetch: () => Effect.void,
        artifacts: Effect.succeed([]),
        activate: () => Effect.die("owner-retirement test does not activate gateways"),
        ingress,
        logStore,
      };
      const supervisor = yield* makeSupervisor({
        stackId,
        ownerSessionId: "owner-session",
        stateStore,
        context,
        runtime,
      }).pipe(Effect.provideContext(context));
      const endpoint = { kind: "unix" as const, path: path.join(root, "control", "owner.sock") };
      const onShutdownReady = Deferred.succeed(shutdownRequested, undefined).pipe(
        Effect.andThen(supervisor.shutdownIfIdle),
      );
      const rpcHandlers: StackRpcHandlers = {
        ...supervisor.rpcHandlers,
        servicesList: (payload, options) =>
          Rpc.wrap({})(
            Effect.gen(function* () {
              if (yield* Ref.get(holdRequest)) {
                yield* Deferred.succeed(requestEntered, undefined);
                yield* Deferred.await(requestRelease);
              }
              const result = Rpc.unwrap(supervisor.rpcHandlers.servicesList(payload, options));
              return yield* Effect.isEffect(result) ? result : Effect.succeed(result);
            }),
          ),
      };
      yield* startControlServer({
        stackId,
        ownerSessionId: "owner-session",
        endpoint,
        rpcRelease: STACK_RPC_RELEASE,
        maintenanceHandlers: supervisor.maintenanceHandlers,
        onShutdownReady,
        onRpcPreface: () =>
          supervisor.acquireRpcPreface.pipe(
            Effect.tap(() => Deferred.succeed(prefaceAcquired, undefined)),
            Effect.map((lease) => ({
              release: lease.release.pipe(
                Effect.andThen(Deferred.succeed(prefaceReleased, undefined)),
              ),
            })),
          ),
        rpcHandlers,
      });
      return yield* f({
        stackId,
        ownerSessionId: "owner-session",
        endpoint,
        supervisor,
        stateStore,
        instanceId,
        destroyFailure,
        destroyCalls,
        cleanupCalls,
        startEntered,
        startRelease,
        startCalls,
        shutdownRequested,
        prefaceAcquired,
        prefaceReleased,
        requestEntered,
        requestRelease,
        holdRequest,
      });
    }),
  );

describe("production owner admission and retirement", { timeout: 30_000 }, () => {
  it.live("flushes metadata before an idle owner retires", () =>
    withFixture(({ endpoint, stackId, ownerSessionId, supervisor, shutdownRequested }) =>
      Effect.gen(function* () {
        const client = makeControlClient(endpoint, {
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
        });
        const probe = yield* client.probe;
        expect(probe).toMatchObject({ ok: true, stackId, ownerSessionId });
        expect(Option.isNone(yield* Deferred.poll(shutdownRequested))).toBe(true);
        const listed = yield* Effect.scoped(
          client.rpc.pipe(Effect.flatMap((rpc) => rpc.servicesList())),
        );
        expect(listed).toHaveLength(1);
        yield* Deferred.await(shutdownRequested).pipe(Effect.timeout("5 seconds"));
        yield* supervisor.shutdown;
      }),
    ),
  );

  it.live("keeps an admitted preface until the actual RPC response", () =>
    withFixture(
      ({
        endpoint,
        stackId,
        ownerSessionId,
        supervisor,
        prefaceAcquired,
        prefaceReleased,
        requestEntered,
        requestRelease,
        holdRequest,
        shutdownRequested,
      }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const client = makeControlClient(endpoint, {
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            });
            const rpc = yield* client.rpc;
            yield* Deferred.await(prefaceAcquired).pipe(Effect.timeout("5 seconds"));
            yield* Ref.set(holdRequest, true);
            const request = yield* Effect.forkChild(rpc.servicesList(), {
              startImmediately: true,
            });
            yield* Deferred.await(requestEntered).pipe(Effect.timeout("5 seconds"));
            yield* supervisor.shutdownIfIdle;
            expect(Option.isNone(yield* Deferred.poll(shutdownRequested))).toBe(true);
            expect(Option.isNone(yield* Deferred.poll(prefaceReleased))).toBe(true);
            yield* Deferred.succeed(requestRelease, undefined);
            const listed = yield* Fiber.join(request);
            expect(listed).toHaveLength(1);
            yield* Deferred.await(prefaceReleased).pipe(Effect.timeout("5 seconds"));
            yield* Deferred.await(shutdownRequested).pipe(Effect.timeout("5 seconds"));
          }),
        ),
    ),
  );

  it.live("does not replay a request after retirement", () =>
    withFixture(({ endpoint, stackId, ownerSessionId, supervisor, instanceId, prefaceAcquired }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = makeControlClient(endpoint, {
            stackId,
            ownerSessionId,
            rpcRelease: STACK_RPC_RELEASE,
          });
          const rpc = yield* client.rpc;
          yield* Deferred.await(prefaceAcquired).pipe(Effect.timeout("5 seconds"));
          yield* supervisor.destroy;
          const request = yield* Effect.exit(rpc.serviceDestroy({ id: instanceId }));
          expect(Exit.isFailure(request)).toBe(true);
        }),
      ),
    ),
  );

  it.live("releases an unused RPC preface when its client disconnects", () =>
    withFixture(({ endpoint, stackId, ownerSessionId, prefaceAcquired, prefaceReleased }) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = makeControlClient(endpoint, {
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            });
            yield* client.rpc;
            yield* Deferred.await(prefaceAcquired).pipe(Effect.timeout("5 seconds"));
          }),
        );
        yield* Deferred.await(prefaceReleased).pipe(Effect.timeout("5 seconds"));
      }),
    ),
  );

  it.live("protects an admitted request when whole-stack retirement races it", () =>
    withFixture(
      ({
        endpoint,
        stackId,
        ownerSessionId,
        supervisor,
        instanceId,
        startEntered,
        startRelease,
        startCalls,
        destroyCalls,
        shutdownRequested,
      }) =>
        Effect.gen(function* () {
          const startFiber = yield* Effect.forkChild(
            Effect.scoped(
              makeControlClient(endpoint, {
                stackId,
                ownerSessionId,
                rpcRelease: STACK_RPC_RELEASE,
              }).rpc.pipe(Effect.flatMap((rpc) => rpc.serviceStart({ id: instanceId }))),
            ),
            { startImmediately: true },
          );
          yield* Deferred.await(startEntered).pipe(Effect.timeout("5 seconds"));
          expect(Option.isNone(yield* Deferred.poll(shutdownRequested))).toBe(true);
          const destroyResult = yield* Effect.scoped(
            makeControlClient(endpoint, {
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }).rpc.pipe(Effect.flatMap((rpc) => Effect.exit(rpc.destroy({})))),
          );
          expect(Exit.isFailure(destroyResult)).toBe(true);
          expect(yield* Ref.get(destroyCalls)).toBe(0);
          yield* Deferred.succeed(startRelease, undefined);
          const started = yield* Fiber.join(startFiber);
          expect(started.phase).toBe("ready");
          expect(yield* Ref.get(startCalls)).toBe(1);
          expect(yield* Ref.get(destroyCalls)).toBe(0);
          expect((yield* supervisor.status).lifecycle).toBe("running");
        }),
    ),
  );

  it.live("keeps RPC usable after a failed whole-stack destroy", () =>
    withFixture(
      ({
        endpoint,
        stackId,
        ownerSessionId,
        instanceId,
        destroyFailure,
        destroyCalls,
        startEntered,
        startRelease,
        startCalls,
      }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const client = makeControlClient(endpoint, {
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            });
            const startFiber = yield* Effect.forkChild(
              Effect.scoped(
                client.rpc.pipe(Effect.flatMap((rpc) => rpc.serviceStart({ id: instanceId }))),
              ),
              { startImmediately: true },
            );
            yield* Deferred.await(startEntered).pipe(Effect.timeout("5 seconds"));
            yield* Deferred.succeed(startRelease, undefined);
            expect((yield* Fiber.join(startFiber)).phase).toBe("ready");
            expect(yield* Ref.get(startCalls)).toBe(1);
            yield* Ref.set(destroyFailure, true);
            const failed = yield* Effect.exit(
              client.rpc.pipe(Effect.flatMap((rpc) => rpc.destroy({}))),
            );
            expect(Exit.isFailure(failed)).toBe(true);
            expect(yield* Ref.get(destroyCalls)).toBe(1);
            const listed = yield* client.rpc.pipe(Effect.flatMap((rpc) => rpc.servicesList()));
            expect(listed).toHaveLength(1);
          }),
        ),
    ),
  );

  it.live("flushes a fresh owner's whole destroy before signaling shutdown", () =>
    withFixture(
      ({
        endpoint,
        stackId,
        ownerSessionId,
        supervisor,
        shutdownRequested,
        destroyCalls,
        cleanupCalls,
      }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const client = makeControlClient(endpoint, {
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            });
            const rpc = yield* client.rpc;
            yield* rpc.destroy({});
            expect(yield* Ref.get(destroyCalls)).toBe(1);
            expect(yield* Ref.get(cleanupCalls)).toBe(1);
            yield* Deferred.await(shutdownRequested).pipe(Effect.timeout("5 seconds"));
            yield* supervisor.shutdown;
          }),
        ),
    ),
  );

  it.live("does not clean stack runtime resources for selected destroy", () =>
    withFixture(({ endpoint, stackId, ownerSessionId, instanceId, cleanupCalls }) =>
      Effect.gen(function* () {
        const client = makeControlClient(endpoint, {
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
        });
        yield* client.rpc.pipe(Effect.flatMap((rpc) => rpc.destroy({ services: [instanceId] })));
        expect(yield* Ref.get(cleanupCalls)).toBe(0);
      }),
    ),
  );
});
