import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Cause,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Path,
  Option,
  Redacted,
  Ref,
} from "effect";
import { compileServiceInstance } from "../model/Compiler.ts";
import { deriveStackId } from "../identity/Identity.ts";
import { makeControlClient, startControlServer } from "../control/ControlServer.ts";
import { STACK_RPC_RELEASE, type StackRpcClient } from "../control/StackRpc.ts";
import {
  unconfiguredServiceRpcHandlers,
  unconfiguredStackRpcHandlers,
} from "../control/test-helpers.ts";
import { StackLifecycleConflictError, type LifecycleOutcome, type StackError } from "./Errors.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import type { RuntimeDriver } from "../runtime/RuntimeDriver.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makeStackStateStore, type StackStateStore } from "../state/StackStateStore.ts";
import { AUTH_JWT_SECRET_SLOT } from "../state/SecretStore.ts";
import type { InstanceRuntimeInput } from "../supervisor/Lifecycle.ts";
import { makeSupervisor, type SupervisorRuntime } from "../supervisor/Supervisor.ts";
import type { SupervisorIngress } from "../supervisor/Ingress.ts";
import type { LogStore } from "../supervisor/LogStore.ts";
import { ServiceInstanceIdSchema, type ServiceInstanceId } from "./ServiceInstanceId.ts";
import { StackIdSchema } from "./StackId.ts";
import { makeHandle, type HandleDependencies } from "./EffectStack.ts";
import { adaptEffectStack } from "./PromiseStack.ts";

const ingress: SupervisorIngress = {
  close: Effect.void,
};
const logStore: LogStore = {
  path: "/dev/null",
  append: () => Effect.die("lifecycle outcome fixture does not write logs"),
  read: () => Effect.succeed([]),
};

type FailureMode = "none" | "functions-start" | "rest-destroy";
interface Fixture {
  readonly endpoint: { readonly kind: "unix"; readonly path: string };
  readonly stackId: string;
  readonly stateStore: StackStateStore;
  readonly database: ServiceInstanceId;
  readonly rest: ServiceInstanceId;
  readonly functions: ServiceInstanceId;
  readonly failure: Ref.Ref<FailureMode>;
  readonly starts: Array<InstanceRuntimeInput>;
  readonly stops: Array<InstanceRuntimeInput>;
  readonly destroys: Array<InstanceRuntimeInput>;
  readonly read: () => Effect.Effect<PersistedStackState | undefined, StackError>;
}

const withRpc = <A, E>(
  fixture: Pick<Fixture, "endpoint" | "stackId">,
  use: (rpc: StackRpcClient) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    makeControlClient(fixture.endpoint, {
      stackId: fixture.stackId,
      ownerSessionId: "lifecycle-outcomes-owner",
      rpcRelease: STACK_RPC_RELEASE,
    }).rpc.pipe(Effect.flatMap(use)),
  );

const failureFrom = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) throw new Error("expected lifecycle operation to fail");
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) throw new Error(`expected typed failure, got ${String(exit.cause)}`);
  return failure.value;
};

const withFixture = <A, E, R>(
  mode: "restart" | "destroy",
  use: (fixture: Fixture) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-outcomes-" });
      const projectRoot = path.join(root, "project");
      yield* fs.makeDirectory(projectRoot);
      const context = Context.make(FileSystem.FileSystem, fs).pipe(
        Context.add(Path.Path, path),
        Context.add(Crypto.Crypto, crypto),
      );
      const identity = {
        projectRoot,
        branchContext: "test",
        stackName: "lifecycle-outcomes",
      } as const;
      const stackId = yield* deriveStackId(identity);
      const databaseId = ServiceInstanceIdSchema.make("11111111-1111-4111-8111-111111111111");
      const restId = ServiceInstanceIdSchema.make("22222222-2222-4222-8222-222222222222");
      const functionsId = ServiceInstanceIdSchema.make("33333333-3333-4333-8333-333333333333");
      const database = yield* compileServiceInstance(
        {
          service: "database",
          name: "primary",
          config: { password: Redacted.make("old"), settings: {} },
        },
        { projectRoot, path, runtime: { kind: "native" }, instanceId: databaseId },
      ).pipe(Effect.provideContext(context));
      const rest = yield* compileServiceInstance(
        {
          service: "rest",
          name: "rest",
          config: { settings: {} },
          dependencies: { database: databaseId },
        },
        { projectRoot, path, runtime: { kind: "native" }, instanceId: restId },
      ).pipe(Effect.provideContext(context));
      const functions = yield* compileServiceInstance(
        { service: "functions", name: "functions", config: { settings: {} } },
        { projectRoot, path, runtime: { kind: "native" }, instanceId: functionsId },
      ).pipe(Effect.provideContext(context));
      const state: PersistedStackState = {
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
        registry: {
          initialized: true,
          instances: [
            { ...database.instance, intent: "started" },
            { ...rest.instance, intent: mode === "destroy" ? "started" : "stopped" },
            { ...functions.instance, intent: "started" },
          ],
          defaultInstanceIds: { database: databaseId, rest: restId, functions: functionsId },
        },
        ports: [],
        privatePorts: [],
        secrets: {
          [AUTH_JWT_SECRET_SLOT]: { policy: "managed", value: "jwt" },
          [`secret:${databaseId}:password`]: { policy: "managed", value: "old" },
        },
      };
      const stateStore = yield* makeStackStateStore({ stateRoot: path.join(root, "state") });
      yield* stateStore.initialize(stackId, state).pipe(Effect.provideContext(context));
      const failure = yield* Ref.make<FailureMode>("none");
      const starts: Array<InstanceRuntimeInput> = [];
      const stops: Array<InstanceRuntimeInput> = [];
      const destroys: Array<InstanceRuntimeInput> = [];
      const runtimeFailure = (message: string) =>
        new StackLifecycleConflictError({ stackId, message });
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed([]),
        start: () => Effect.die("lifecycle outcome fixture does not start workloads"),
        stop: () => Effect.die("lifecycle outcome fixture does not stop workloads"),
        remove: () => Effect.die("lifecycle outcome fixture does not remove workloads"),
        cleanup: () => Effect.die("lifecycle outcome fixture does not clean workloads"),
        wipePersistentData: () => Effect.die("lifecycle outcome fixture does not wipe workloads"),
      };
      const runtime: SupervisorRuntime = {
        driver,
        preflight: () => Effect.void,
        prepare: () => Effect.succeed({ instances: [] }),
        prepareArtifacts: () => Effect.void,
        start: (input) =>
          Effect.gen(function* () {
            starts.push(input);
            if (
              input.instance.id === functionsId &&
              (yield* Ref.get(failure)) === "functions-start"
            )
              return yield* runtimeFailure("Functions failed while starting");
            return [] as ReadonlyArray<RuntimeBindingPublication>;
          }),
        stop: (input) => Effect.sync(() => stops.push(input)),
        destroy: (input) =>
          Effect.gen(function* () {
            destroys.push(input);
            if (input.instance.id === restId && (yield* Ref.get(failure)) === "rest-destroy")
              return yield* runtimeFailure("REST cleanup failed");
          }),
        exportSnapshot: () => Effect.fail(runtimeFailure("snapshot is outside this fixture")),
        restoreSnapshot: () => Effect.fail(runtimeFailure("snapshot is outside this fixture")),
        prefetch: () => Effect.void,
        artifacts: Effect.succeed([]),
        activate: () => Effect.die("lifecycle outcome fixture does not activate gateways"),
        ingress,
        logStore,
      };
      const supervisor = yield* makeSupervisor({
        stackId,
        ownerSessionId: "lifecycle-outcomes-owner",
        stateStore,
        context,
        runtime,
      }).pipe(Effect.provideContext(context));
      const endpoint = { kind: "unix" as const, path: path.join(root, "control", "owner.sock") };
      yield* startControlServer({
        stackId,
        ownerSessionId: "lifecycle-outcomes-owner",
        endpoint,
        rpcRelease: STACK_RPC_RELEASE,
        maintenanceHandlers: supervisor.maintenanceHandlers,
        rpcHandlers: supervisor.rpcHandlers,
      });
      return yield* use({
        endpoint,
        stackId,
        stateStore,
        database: databaseId,
        rest: restId,
        functions: functionsId,
        failure,
        starts,
        stops,
        destroys,
        read: () => stateStore.read(stackId).pipe(Effect.provideContext(context)),
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const restartUpdate = (id: ServiceInstanceId) => ({
  id,
  service: "database" as const,
  config: { password: Redacted.make("new"), settings: {} },
});

describe("lifecycle outcomes", { timeout: 30_000 }, () => {
  it.live("reports partial restart results through the control RPC and state", () =>
    withFixture("restart", ({ endpoint, stackId, database, functions, failure, starts, read }) =>
      Effect.gen(function* () {
        yield* Ref.set(failure, "functions-start");
        const result = yield* withRpc({ endpoint, stackId }, (rpc) =>
          rpc.restart({ services: [database, functions], updates: [restartUpdate(database)] }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const error = failureFrom(result);
        expect(error).toMatchObject({
          tag: "StackLifecycleConflictError",
          outcome: {
            requested: [database, functions],
            affected: [database, functions],
            succeeded: [database],
            failed: [functions],
          } satisfies Partial<LifecycleOutcome>,
        });
        expect(starts.map((input) => input.instance.id)).toEqual(
          expect.arrayContaining([database, functions]),
        );
        const after = yield* read();
        expect(
          after?.registry.instances.every((instance) => instance.pendingOperation === null),
        ).toBe(true);
        expect(after?.secrets[`secret:${database}:password`]?.value).toBe("new");
      }),
    ),
  );

  it.live(
    "retains the database when a dependent destroy fails and reports independent removal",
    () =>
      withFixture(
        "destroy",
        ({ endpoint, stackId, database, rest, functions, failure, destroys, read }) =>
          Effect.gen(function* () {
            yield* Ref.set(failure, "rest-destroy");
            const result = yield* withRpc({ endpoint, stackId }, (rpc) =>
              rpc.destroy({ services: [database, rest, functions] }),
            ).pipe(Effect.exit);
            expect(Exit.isFailure(result)).toBe(true);
            const error = failureFrom(result);
            expect(error).toMatchObject({
              tag: "StackDestructionError",
              outcome: {
                requested: [database, rest, functions],
                affected: [rest, database, functions],
                succeeded: [functions],
                failed: [rest, database],
                retained: expect.arrayContaining([rest, database]),
                removed: [functions],
              },
            });
            expect(destroys.map((input) => input.instance.id)).toEqual([rest, functions]);
            const after = yield* read();
            expect(after?.registry.instances.map((instance) => instance.id)).toEqual(
              expect.arrayContaining([database, rest]),
            );
          }),
      ),
  );

  it.live("preserves lifecycle outcome fields through Effect and Promise facades", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-facade-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control", "owner.sock") };
        const facadeStackId = StackIdSchema.make(
          "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        );
        const outcome: LifecycleOutcome = {
          requested: ["service-a", "service-b"],
          affected: ["service-a", "service-b"],
          succeeded: ["service-a"],
          failed: ["service-b"],
          retained: ["service-b"],
          removed: ["service-a"],
        };
        const rpcError: import("../control/StackRpc.ts").StackRpcError = {
          tag: "StackLifecycleConflictError",
          message: "partial restart",
          stackId: facadeStackId,
          outcome,
        };
        const ownerSessionId = "lifecycle-facade-owner";
        yield* startControlServer({
          endpoint,
          stackId: facadeStackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            ...unconfiguredServiceRpcHandlers,
            ...unconfiguredStackRpcHandlers,
            restart: () => Effect.fail(rpcError),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe" as const,
              stackId: facadeStackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true, op: "stop" as const }),
          },
        });
        const dependencies: HandleDependencies = {
          resolveOwner: () =>
            Effect.succeed(
              Option.some({
                owner: {
                  format: "supabase-stack-owner-v1" as const,
                  stackId: facadeStackId,
                  endpoint,
                  ownerSessionId,
                  leasePort: 45_003,
                  rpcRelease: STACK_RPC_RELEASE,
                },
                launched: false,
              }),
            ),
          readOfflineState: Effect.succeed(Option.none()),
          readPersistedState: Effect.succeed(Option.none()),
          readLogs: () =>
            Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: false }),
          waitForRelease: () => Effect.void,
          prepare: () => Effect.succeed({ instances: [] }),
        };
        const effectStack = yield* makeHandle(facadeStackId, dependencies);
        const effectResult = yield* effectStack.restart({ services: [] }).pipe(Effect.exit);
        expect(Exit.isFailure(effectResult)).toBe(true);
        if (Exit.isFailure(effectResult)) {
          const effectError = Cause.findErrorOption(effectResult.cause);
          expect(Option.isSome(effectError)).toBe(true);
          if (Option.isSome(effectError))
            expect(effectError.value).toMatchObject({
              _tag: "StackLifecycleConflictError",
              outcome,
            });
        }

        const promiseStack = adaptEffectStack(effectStack);
        const promiseResult = yield* Effect.tryPromise({
          try: () => promiseStack.restart({ services: [] }),
          catch: (error) =>
            error instanceof StackLifecycleConflictError
              ? error
              : new StackLifecycleConflictError({
                  message: error instanceof Error ? error.message : String(error),
                  cause: error,
                }),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(promiseResult)).toBe(true);
        if (Exit.isFailure(promiseResult)) {
          const promiseError = Cause.findErrorOption(promiseResult.cause);
          expect(Option.isSome(promiseError)).toBe(true);
          if (Option.isSome(promiseError)) {
            expect(promiseError.value).toMatchObject({
              _tag: "StackLifecycleConflictError",
              outcome,
            });
          }
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
