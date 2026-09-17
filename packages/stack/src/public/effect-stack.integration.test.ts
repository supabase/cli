import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { startControlServer } from "../control/ControlServer.ts";
import { STACK_RPC_RELEASE, type StackRpcError } from "../control/StackRpc.ts";
import { ServiceDescriptorSchema } from "../control/ServiceProtocol.ts";
import {
  unconfiguredServiceRpcHandlers,
  unconfiguredStackRpcHandlers,
} from "../control/test-helpers.ts";
import { makeHandle, type HandleDependencies } from "./EffectStack.ts";
import { StackNotFoundError, StackOwnershipConflictError, type StackError } from "./Errors.ts";
import { StackIdSchema } from "./StackId.ts";
import { ServiceInstanceIdSchema } from "./ServiceInstanceId.ts";
import type { PersistedStackState } from "../state/StackState.ts";

const stackId = StackIdSchema.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);

const makeTestHandle = (overrides: Partial<HandleDependencies> = {}) =>
  makeHandle(stackId, {
    resolveOwner: () => Effect.succeed(Option.none()),
    readOfflineState: Effect.succeed(Option.none()),
    readPersistedState: Effect.succeed(Option.none()),
    readLogs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: false }),
    waitForRelease: () => Effect.void,
    prepare: () => Effect.succeed({ instances: [] }),
    ...overrides,
  });

const errorFrom = (exit: Exit.Exit<unknown, StackError>): StackError => {
  if (Exit.isSuccess(exit)) throw new Error("expected the operation to fail");
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error))
    throw new Error(`expected a typed operation error: ${String(exit.cause)}`);
  return error.value;
};

describe("Effect stack public lifecycle", () => {
  it.effect("keeps preparation side effect free and exposes every lifecycle operation", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const stack = yield* makeTestHandle({
        prepare: (options) =>
          Effect.sync(() => {
            calls.push(`prepare:${options?.services?.join(",") ?? "all"}`);
            return { instances: [] };
          }),
      });

      expect(yield* stack.prepare({ services: [] })).toEqual({ instances: [] });
      expect(calls).toEqual(["prepare:"]);

      const start = yield* stack.start({ services: [] }).pipe(Effect.exit);
      const sleep = yield* stack.sleep({ services: [] }).pipe(Effect.exit);
      const stop = yield* stack.stop({ services: [] }).pipe(Effect.exit);
      const restart = yield* stack.restart({ services: [] }).pipe(Effect.exit);
      const destroy = yield* stack.destroy({ services: [] });

      for (const result of [start, sleep, stop, restart]) {
        expect(errorFrom(result)).toBeInstanceOf(StackOwnershipConflictError);
      }
      expect(destroy).toBeUndefined();
    }),
  );

  it.effect("reports a missing offline stack through status and credentials", () =>
    Effect.gen(function* () {
      const stack = yield* makeTestHandle();
      const status = yield* stack.status.pipe(Effect.exit);
      expect(errorFrom(status)).toBeInstanceOf(StackNotFoundError);

      const credentials = yield* stack.credentials.pipe(Effect.exit);
      expect(errorFrom(credentials)).toBeInstanceOf(StackNotFoundError);
    }),
  );

  it.effect("requires an owner for service streams and leaves the stream reusable", () =>
    Effect.gen(function* () {
      const stack = yield* makeTestHandle();
      const result = yield* Stream.runCollect(stack.followStatus).pipe(Effect.exit);
      expect(errorFrom(result)).toBeInstanceOf(StackOwnershipConflictError);
    }),
  );

  it.live("preserves the expected creation digest on an uncertain service create", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-uncertain-create-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "uncertain-create-owner";
        const uncertain: StackRpcError = {
          tag: "UncertainOperationError",
          message: "Create response was lost",
          stackId,
          operationId: "create-operation",
          mutation: "create",
        };
        const retiring: StackRpcError = {
          tag: "OwnerRetiringError",
          message: "Owner is retiring before admission",
          stackId,
          ownerSessionId,
        };
        const descriptor: Schema.Schema.Type<typeof ServiceDescriptorSchema> = {
          id: ServiceInstanceIdSchema.make("functions-created"),
          service: "functions",
          name: "created",
          enabled: true,
          config: {
            enabled: true,
            activation: "lazy",
            idleTimeoutSeconds: false,
            version: "test",
            settings: {},
          },
          dependencies: {},
          snapshotSupport: "unsupported",
          endpoints: {
            inspector: {
              address: "127.0.0.1",
              port: 45_002,
              url: "http://127.0.0.1:45002",
            },
          },
          data: { origin: "absent" },
        };
        const createCommitted = yield* Ref.make(false);
        const releaseObserved = yield* Ref.make(false);
        const rejectBeforeAdmission = yield* Ref.make(true);
        const ownerResolutions = yield* Ref.make(0);
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            ...unconfiguredStackRpcHandlers,
            ...unconfiguredServiceRpcHandlers,
            servicesCreate: () =>
              Ref.getAndSet(rejectBeforeAdmission, false).pipe(
                Effect.flatMap((shouldRetire) =>
                  shouldRetire
                    ? Effect.fail(retiring)
                    : Ref.set(createCommitted, true).pipe(Effect.andThen(Effect.fail(uncertain))),
                ),
              ),
            servicesList: () =>
              Ref.get(createCommitted).pipe(
                Effect.map((committed) => (committed ? [descriptor] : [])),
              ),
            status: () => Effect.fail(uncertain),
            followStatus: () => Stream.fail(uncertain),
            credentials: () => Effect.fail(uncertain),
            start: () => Effect.fail(uncertain),
            sleep: () => Effect.fail(uncertain),
            stop: () => Effect.fail(uncertain),
            restart: () => Effect.fail(uncertain),
            destroy: () => Effect.void,
            logs: () => Effect.fail(uncertain),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true, op: "stop" as const }),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle({
          resolveOwner: () =>
            Ref.updateAndGet(ownerResolutions, (count) => count + 1).pipe(
              Effect.as(
                Option.some({
                  owner: {
                    format: "supabase-stack-owner-v1" as const,
                    stackId,
                    endpoint,
                    ownerSessionId,
                    leasePort: 45_001,
                    rpcRelease: STACK_RPC_RELEASE,
                  },
                  launched: false,
                }),
              ),
            ),
          waitForRelease: (session) =>
            Effect.sync(() => {
              expect(session).toBe(ownerSessionId);
            }).pipe(Effect.andThen(Ref.set(releaseObserved, true))),
          fingerprintCreationInputs: () => Effect.succeed("expected-create-digest"),
        });
        const result = yield* stack.services
          .create({ service: "functions", config: { enabled: false } })
          .pipe(Effect.exit);
        const error = errorFrom(result);
        expect(error).toBeInstanceOf(Error);
        expect(error._tag).toBe("UncertainOperationError");
        if (error._tag === "UncertainOperationError")
          expect(error.expectedCreationInputsId).toBe("expected-create-digest");
        expect(yield* Ref.get(releaseObserved)).toBe(true);
        expect(yield* Ref.get(ownerResolutions)).toBe(2);
        expect(yield* stack.services.list).toEqual([descriptor]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("surfaces post-dispatch create transport loss without replaying the mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-post-dispatch-create-",
        });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "post-dispatch-create-owner";
        const ownerScope = yield* Scope.make();
        const createDispatched = yield* Deferred.make<void>();
        const createCalls = yield* Ref.make(0);
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            ...unconfiguredStackRpcHandlers,
            ...unconfiguredServiceRpcHandlers,
            servicesCreate: () =>
              Ref.update(createCalls, (calls) => calls + 1).pipe(
                Effect.andThen(Deferred.succeed(createDispatched, undefined)),
                Effect.andThen(Effect.never),
              ),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe" as const,
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true as const, op: "stop" as const }),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const resolutions = yield* Ref.make(0);
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_007,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const stack = yield* makeTestHandle({
          resolveOwner: () =>
            Ref.updateAndGet(resolutions, (count) => count + 1).pipe(
              Effect.as(Option.some({ owner, launched: false })),
            ),
          fingerprintCreationInputs: () => Effect.succeed("post-dispatch-create-digest"),
        });
        const request = yield* Effect.forkChild(
          stack.services.create({ service: "functions", config: { enabled: false } }),
          { startImmediately: true },
        );
        yield* Deferred.await(createDispatched);
        yield* Scope.close(ownerScope, Exit.void);
        const result = yield* Fiber.join(request).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const error = errorFrom(result);
        expect(error._tag).toBe("UncertainOperationError");
        if (error._tag === "UncertainOperationError") {
          expect(error.stackId).toBe(stackId);
          expect(error.mutation).toBe("create");
          expect(error.expectedCreationInputsId).toBe("post-dispatch-create-digest");
        }
        expect(yield* Ref.get(createCalls)).toBe(1);
        expect(yield* Ref.get(resolutions)).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("keeps a shared owner usable when a start response is uncertain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-interrupted-start-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "interrupted-start-owner";
        const maintenanceStopped = yield* Ref.make(false);
        const failedStart: StackRpcError = {
          tag: "UncertainOperationError",
          message: "Start response was interrupted",
          stackId,
          ownerSessionId,
          operationId: "start-operation",
          mutation: "start",
        };
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            ...unconfiguredServiceRpcHandlers,
            servicesList: () => Effect.succeed([]),
            status: () => Effect.fail(failedStart),
            followStatus: () => Stream.fail(failedStart),
            credentials: () => Effect.fail(failedStart),
            start: () => Effect.fail(failedStart),
            sleep: () => Effect.fail(failedStart),
            stop: () => Effect.fail(failedStart),
            restart: () => Effect.fail(failedStart),
            destroy: () => Effect.void,
            logs: () => Effect.fail(failedStart),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Ref.set(maintenanceStopped, true).pipe(
              Effect.andThen(Effect.succeed({ ok: true as const, op: "stop" as const })),
            ),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const stack = yield* makeTestHandle({
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: true })),
          waitForRelease: () => Ref.set(maintenanceStopped, true),
        });
        const result = yield* stack.start().pipe(Effect.exit);
        expect(errorFrom(result)._tag).toBe("UncertainOperationError");
        expect(yield* Ref.get(maintenanceStopped)).toBe(false);
        expect(yield* stack.services.list).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("does not stop a shared owner when a launching client is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-interrupted-launch-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "interrupted-launch-owner";
        const maintenanceStopped = yield* Ref.make(false);
        const started = yield* Ref.make(false);
        const startEntered = yield* Deferred.make<void>();
        const instanceId = ServiceInstanceIdSchema.make("started-functions");
        const descriptor: Schema.Schema.Type<typeof ServiceDescriptorSchema> = {
          id: instanceId,
          service: "functions",
          name: "started",
          enabled: true,
          config: {
            enabled: true,
            activation: "lazy",
            idleTimeoutSeconds: false,
            version: "test",
            settings: {},
          },
          dependencies: {},
          snapshotSupport: "unsupported",
          endpoints: {},
          data: { origin: "absent" },
        };
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            ...unconfiguredServiceRpcHandlers,
            ...unconfiguredStackRpcHandlers,
            servicesList: () =>
              Ref.get(started).pipe(Effect.map((isStarted) => (isStarted ? [descriptor] : []))),
            start: () =>
              Ref.set(started, true).pipe(
                Effect.andThen(Deferred.succeed(startEntered, undefined)),
                Effect.andThen(Effect.never),
              ),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Ref.set(maintenanceStopped, true).pipe(
              Effect.andThen(Effect.succeed({ ok: true as const, op: "stop" as const })),
            ),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const launchingStack = yield* makeTestHandle({
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: true })),
        });
        const launchingFiber = yield* Effect.forkChild(launchingStack.start(), {
          startImmediately: true,
        });
        yield* Deferred.await(startEntered);

        const sharedStack = yield* makeTestHandle({
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: false })),
        });
        expect(yield* sharedStack.services.list).toEqual([descriptor]);
        yield* Fiber.interrupt(launchingFiber);
        expect(yield* Ref.get(maintenanceStopped)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("keeps the owner and registered identity after selected destroy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-selected-destroy-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "selected-destroy-owner";
        const instanceId = ServiceInstanceIdSchema.make("selected-functions");
        const destroyCalls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
        const descriptor: Schema.Schema.Type<typeof ServiceDescriptorSchema> = {
          id: instanceId,
          service: "functions",
          name: "selected",
          enabled: true,
          config: {
            enabled: true,
            activation: "lazy",
            idleTimeoutSeconds: false,
            version: "test",
            settings: {},
          },
          dependencies: {},
          snapshotSupport: "unsupported",
          endpoints: {},
          data: { origin: "absent" },
        };
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            ...unconfiguredServiceRpcHandlers,
            ...unconfiguredStackRpcHandlers,
            servicesList: () => Effect.succeed([descriptor]),
            destroy: (payload) =>
              Ref.update(destroyCalls, (calls) => [
                ...calls,
                payload.services?.map(String) ?? [],
              ]).pipe(Effect.asVoid),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true, op: "stop" as const }),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const stack = yield* makeTestHandle({
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: false })),
        });

        yield* stack.destroy({ services: [] });
        expect(yield* Ref.get(destroyCalls)).toEqual([]);
        yield* stack.destroy({ services: [instanceId] });
        expect(yield* Ref.get(destroyCalls)).toEqual([[String(instanceId)]]);
        expect(stack.id).toBe(stackId);
        expect(yield* stack.services.list).toEqual([descriptor]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("waits for the owner release after acknowledged whole destroy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-whole-destroy-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "whole-destroy-owner";
        const ownerReleased = yield* Ref.make(false);
        const shutdownRequested = yield* Deferred.make<void>();
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const persistedState: PersistedStackState = {
          format: "supabase-stack-state-v2",
          identity: {
            projectRoot: "/tmp/project",
            branchContext: "ordinary-workspace",
            stackName: "default",
          },
          runtime: { kind: "native" },
          preparation: "on-demand",
          security: {
            jwt: {
              issuer: null,
              expirySeconds: 3_600,
              signing: { kind: "symmetric", secret: { slot: "secret:jwt" } },
            },
          },
          listeners: {},
          registry: { initialized: true, instances: [], defaultInstanceIds: {} },
          ports: [],
          privatePorts: [],
          secrets: {},
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          onShutdownReady: Deferred.succeed(shutdownRequested, undefined),
          rpcHandlers: {
            ...unconfiguredServiceRpcHandlers,
            ...unconfiguredStackRpcHandlers,
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true, op: "stop" as const }),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        yield* Effect.forkChild(
          Deferred.await(shutdownRequested).pipe(
            Effect.andThen(Ref.set(ownerReleased, true)),
            Effect.andThen(Scope.close(ownerScope, Exit.void)),
          ),
          { startImmediately: true },
        );
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const stack = yield* makeTestHandle({
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: true })),
          readPersistedState: Effect.succeed(Option.some(persistedState)),
        });

        yield* stack.destroy();
        expect(yield* Ref.get(ownerReleased)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("does not replay when the owner closes during RPC admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-owner-close-before-rpc-",
        });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "owner-close-before-rpc";
        const ownerScope = yield* Scope.make();
        const requestStarted = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            ...unconfiguredServiceRpcHandlers,
            ...unconfiguredStackRpcHandlers,
            servicesList: () =>
              Deferred.succeed(requestStarted, undefined).pipe(Effect.andThen(Effect.never)),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe" as const,
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true, op: "stop" as const }),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const resolutions = yield* Ref.make(0);
        const releases = yield* Ref.make<ReadonlyArray<string>>([]);
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_004,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const stack = yield* makeTestHandle({
          resolveOwner: () =>
            Ref.updateAndGet(resolutions, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed(Option.some({ owner, launched: false }))
                  : Effect.succeed(Option.none()),
              ),
            ),
          waitForRelease: (session) =>
            Ref.update(releases, (sessions) => [...sessions, session ?? "missing"]),
        });
        const request = yield* Effect.forkChild(stack.services.list, { startImmediately: true });
        yield* Deferred.await(requestStarted);
        yield* Scope.close(ownerScope, Exit.void);
        const result = yield* Fiber.join(request).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(errorFrom(result)).toBeInstanceOf(StackOwnershipConflictError);
        expect(yield* Ref.get(releases)).toEqual([]);
        expect(yield* Ref.get(resolutions)).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("re-resolves once when the owner closes before RPC connection admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-owner-reconnect-" });
        const firstEndpoint = { kind: "unix" as const, path: path.join(root, "first.sock") };
        const secondEndpoint = { kind: "unix" as const, path: path.join(root, "second.sock") };
        const firstOwnerSessionId = "owner-before-connect";
        const secondOwnerSessionId = "owner-after-connect";
        const firstOwnerScope = yield* Scope.make();
        const secondOwnerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(firstOwnerScope, Exit.void));
        yield* Effect.addFinalizer(() => Scope.close(secondOwnerScope, Exit.void));
        const maintenanceHandlers = (ownerSessionId: string) => ({
          probe: Effect.succeed({
            ok: true as const,
            op: "probe" as const,
            stackId,
            ownerSessionId,
            rpcRelease: STACK_RPC_RELEASE,
          }),
          stop: Effect.succeed({ ok: true as const, op: "stop" as const }),
        });
        yield* startControlServer({
          endpoint: firstEndpoint,
          stackId,
          ownerSessionId: firstOwnerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            ...unconfiguredServiceRpcHandlers,
            ...unconfiguredStackRpcHandlers,
          },
          maintenanceHandlers: maintenanceHandlers(firstOwnerSessionId),
        }).pipe(Effect.provideService(Scope.Scope, firstOwnerScope));
        yield* startControlServer({
          endpoint: secondEndpoint,
          stackId,
          ownerSessionId: secondOwnerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            ...unconfiguredServiceRpcHandlers,
            ...unconfiguredStackRpcHandlers,
            servicesList: () => Effect.succeed([]),
          },
          maintenanceHandlers: maintenanceHandlers(secondOwnerSessionId),
        }).pipe(Effect.provideService(Scope.Scope, secondOwnerScope));
        const firstOwner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint: firstEndpoint,
          ownerSessionId: firstOwnerSessionId,
          leasePort: 45_005,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const secondOwner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint: secondEndpoint,
          ownerSessionId: secondOwnerSessionId,
          leasePort: 45_006,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const resolutions = yield* Ref.make(0);
        const releases = yield* Ref.make<ReadonlyArray<string>>([]);
        const stack = yield* makeTestHandle({
          resolveOwner: () =>
            Ref.updateAndGet(resolutions, (count) => count + 1).pipe(
              Effect.map((count) =>
                Option.some({
                  owner: count === 1 ? firstOwner : secondOwner,
                  launched: false,
                }),
              ),
            ),
          waitForRelease: (session) =>
            Ref.update(releases, (sessions) => [...sessions, session ?? "missing"]),
        });

        yield* Scope.close(firstOwnerScope, Exit.void);
        expect(yield* stack.services.list).toEqual([]);
        expect(yield* Ref.get(resolutions)).toBe(2);
        expect(yield* Ref.get(releases)).toEqual([firstOwnerSessionId]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
