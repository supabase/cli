import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Crypto, Effect, Exit, FileSystem, Path, Redacted } from "effect";
import { compileServiceInstance } from "../model/Compiler.ts";
import type { PersistedServiceInstance } from "../model/ServiceRegistry.ts";
import { deriveStackId } from "../identity/Identity.ts";
import { makeControlClient, startControlServer } from "../control/ControlServer.ts";
import { STACK_RPC_RELEASE, type StackRpcClient } from "../control/StackRpc.ts";
import { StackLifecycleConflictError, type StackError } from "../public/Errors.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import type { RuntimeDriver } from "../runtime/RuntimeDriver.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makeStackStateStore, type StackStateStore } from "../state/StackStateStore.ts";
import { AUTH_JWT_SECRET_SLOT } from "../state/SecretStore.ts";
import type { InstanceRuntimeInput } from "./Lifecycle.ts";
import { makeSupervisor, type Supervisor, type SupervisorRuntime } from "./Supervisor.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import type { LogStore } from "./LogStore.ts";
import { ServiceInstanceIdSchema, type ServiceInstanceId } from "../public/ServiceInstanceId.ts";

const ingress: SupervisorIngress = {
  close: Effect.void,
};
const logStore: LogStore = {
  path: "/dev/null",
  append: () => Effect.die("whole restart test does not write logs"),
  read: () => Effect.succeed([]),
};

interface Fixture {
  readonly endpoint: { readonly kind: "unix"; readonly path: string };
  readonly stackId: string;
  readonly stateStore: StackStateStore;
  readonly supervisor: Supervisor;
  readonly database: ServiceInstanceId;
  readonly rest: ServiceInstanceId;
  readonly functions: ServiceInstanceId;
  readonly dynamic: ServiceInstanceId;
  readonly starts: Array<InstanceRuntimeInput>;
  readonly stops: Array<InstanceRuntimeInput>;
  readonly read: () => Effect.Effect<PersistedStackState | undefined, StackError>;
}

const withRpc = <A, E>(
  fixture: Pick<Fixture, "endpoint" | "stackId">,
  use: (rpc: StackRpcClient) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    makeControlClient(fixture.endpoint, {
      stackId: fixture.stackId,
      ownerSessionId: "whole-restart-owner",
      rpcRelease: STACK_RPC_RELEASE,
    }).rpc.pipe(Effect.flatMap(use)),
  );

const withFixture = <A, E, R>(use: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-whole-restart-" });
      const projectRoot = path.join(root, "project");
      yield* fs.makeDirectory(projectRoot);
      const context = Context.make(FileSystem.FileSystem, fs).pipe(
        Context.add(Path.Path, path),
        Context.add(Crypto.Crypto, crypto),
      );
      const identity = { projectRoot, branchContext: "test", stackName: "whole-restart" } as const;
      const stackId = yield* deriveStackId(identity);
      const database = yield* compileServiceInstance(
        {
          service: "database",
          name: "primary",
          config: {
            password: Redacted.make("old"),
            settings: {},
            endpoints: { sql: { address: "127.0.0.1", port: 25_124 } },
          },
        },
        {
          projectRoot,
          path,
          runtime: { kind: "native" },
          instanceId: ServiceInstanceIdSchema.make("11111111-1111-4111-8111-111111111111"),
        },
      ).pipe(Effect.provideContext(context));
      if (database.instance.service !== "database")
        return yield* new StackLifecycleConflictError({ message: "database fixture is invalid" });
      const databaseInstance = database.instance;
      const rest = yield* compileServiceInstance(
        {
          service: "rest",
          name: "rest",
          config: {},
          dependencies: { database: databaseInstance.id },
        },
        {
          projectRoot,
          path,
          runtime: { kind: "native" },
          instanceId: ServiceInstanceIdSchema.make("22222222-2222-4222-8222-222222222222"),
        },
      ).pipe(Effect.provideContext(context));
      if (rest.instance.service !== "rest")
        return yield* new StackLifecycleConflictError({ message: "rest fixture is invalid" });
      const restInstance = rest.instance;
      const functions = yield* compileServiceInstance(
        { service: "functions", name: "functions", config: {} },
        {
          projectRoot,
          path,
          runtime: { kind: "native" },
          instanceId: ServiceInstanceIdSchema.make("33333333-3333-4333-8333-333333333333"),
        },
      ).pipe(Effect.provideContext(context));
      if (functions.instance.service !== "functions")
        return yield* new StackLifecycleConflictError({ message: "functions fixture is invalid" });
      const functionsInstance = functions.instance;
      const dynamic = yield* compileServiceInstance(
        {
          service: "rest",
          name: "dynamic",
          config: {},
          dependencies: { database: databaseInstance.id },
        },
        {
          projectRoot,
          path,
          runtime: { kind: "native" },
          instanceId: ServiceInstanceIdSchema.make("44444444-4444-4444-8444-444444444444"),
        },
      ).pipe(Effect.provideContext(context));
      if (dynamic.instance.service !== "rest")
        return yield* new StackLifecycleConflictError({ message: "dynamic fixture is invalid" });
      const dynamicInstance = dynamic.instance;
      const started = (instance: PersistedServiceInstance): PersistedServiceInstance => ({
        ...instance,
        intent: "started",
      });
      const lazy = (instance: typeof restInstance): typeof restInstance => ({
        ...instance,
        config: { ...instance.config, activation: "lazy" },
      });
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
        listeners: { api: { enabled: true, address: "127.0.0.1" } },
        registry: {
          initialized: true,
          instances: [
            started({
              ...databaseInstance,
              initializationInputs: { profileId: "test-profile", catalog: {} },
            }),
            lazy(restInstance),
            functionsInstance,
            started(dynamicInstance),
          ],
          defaultInstanceIds: {
            database: databaseInstance.id,
            rest: restInstance.id,
            functions: functionsInstance.id,
          },
        },
        ports: [
          {
            owner: "stack",
            binding: "api",
            address: "127.0.0.1",
            port: 25_123,
            intent: "automatic",
          },
        ],
        privatePorts: [],
        secrets: {
          [AUTH_JWT_SECRET_SLOT]: { policy: "managed", value: "old-jwt" },
          [`secret:${databaseInstance.id}:password`]: { policy: "managed", value: "old" },
        },
      };
      const stateStore = yield* makeStackStateStore({ stateRoot: path.join(root, "state") });
      yield* stateStore.initialize(stackId, state).pipe(Effect.provideContext(context));
      const starts: Array<InstanceRuntimeInput> = [];
      const stops: Array<InstanceRuntimeInput> = [];
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed([]),
        start: () => Effect.die("whole restart test does not start driver workloads"),
        stop: () => Effect.die("whole restart test does not stop driver workloads"),
        remove: () => Effect.die("whole restart test does not remove driver workloads"),
        cleanup: () => Effect.die("whole restart test does not clean driver workloads"),
        wipePersistentData: () => Effect.die("whole restart test does not wipe driver workloads"),
      };
      const runtime: SupervisorRuntime = {
        driver,
        preflight: () => Effect.void,
        prepare: () => Effect.succeed({ instances: [] }),
        prepareArtifacts: () => Effect.void,
        start: (input) =>
          Effect.sync(() => {
            starts.push(input);
            return [] as ReadonlyArray<RuntimeBindingPublication>;
          }),
        stop: (input) =>
          Effect.sync(() => {
            stops.push(input);
          }),
        destroy: () => Effect.void,
        exportSnapshot: () =>
          Effect.fail(new StackLifecycleConflictError({ message: "outside test" })),
        restoreSnapshot: () =>
          Effect.fail(new StackLifecycleConflictError({ message: "outside test" })),
        prefetch: () => Effect.void,
        artifacts: Effect.succeed([]),
        activate: () => Effect.die("whole restart test does not activate gateways"),
        ingress,
        logStore,
      };
      const supervisor = yield* makeSupervisor({
        stackId,
        ownerSessionId: "whole-restart-owner",
        stateStore,
        context,
        runtime,
      }).pipe(Effect.provideContext(context));
      const endpoint = { kind: "unix" as const, path: path.join(root, "control", "owner.sock") };
      yield* startControlServer({
        stackId,
        ownerSessionId: "whole-restart-owner",
        endpoint,
        rpcRelease: STACK_RPC_RELEASE,
        maintenanceHandlers: supervisor.maintenanceHandlers,
        rpcHandlers: supervisor.rpcHandlers,
      });
      return yield* use({
        endpoint,
        stackId,
        stateStore,
        supervisor,
        database: databaseInstance.id,
        rest: restInstance.id,
        functions: functionsInstance.id,
        dynamic: dynamicInstance.id,
        starts,
        stops,
        read: () => stateStore.read(stackId).pipe(Effect.provideContext(context)),
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const validConfig = {
  preparation: "on-demand" as const,
  listeners: { api: { address: "127.0.0.1", port: 25_123 } },
  security: {
    jwt: {
      expirySeconds: 7_200,
      signing: { kind: "symmetric" as const, secret: Redacted.make("new-jwt") },
    },
  },
  capabilities: {
    rest: { activation: "lazy" as const },
    functions: { enabled: false as const },
  },
};

describe("whole stack restart policy", { timeout: 30_000 }, () => {
  it.live("rejects an invalid whole configuration atomically", () =>
    withFixture(({ endpoint, stackId, read, starts, stops }) =>
      Effect.gen(function* () {
        const before = yield* read();
        const result = yield* withRpc({ endpoint, stackId }, (rpc) =>
          rpc.restart({ config: { capabilities: { database: { version: "not-a-release" } } } }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* read()).toEqual(before);
        expect(starts).toHaveLength(0);
        expect(stops).toHaveLength(0);
      }),
    ),
  );

  it.live("applies a valid whole config while retaining dynamic and initialized state", () =>
    withFixture(({ endpoint, stackId, read, database, rest, functions, dynamic, starts, stops }) =>
      Effect.gen(function* () {
        const before = yield* read();
        if (before === undefined)
          return yield* new StackLifecycleConflictError({ message: "state missing" });
        const databaseBefore = before.registry.instances.find(
          (instance) => instance.id === database,
        );
        if (databaseBefore === undefined)
          return yield* new StackLifecycleConflictError({ message: "database missing" });
        yield* withRpc({ endpoint, stackId }, (rpc) => rpc.serviceDestroy({ id: functions }));
        starts.length = 0;
        stops.length = 0;
        const result = yield* withRpc({ endpoint, stackId }, (rpc) =>
          rpc.restart({ config: validConfig }),
        );
        expect(result.instances.map((instance) => instance.id)).toEqual(
          expect.arrayContaining([database, rest, dynamic]),
        );
        const after = yield* read();
        expect(after?.registry.instances.map((instance) => instance.id)).toEqual(
          expect.arrayContaining([database, rest, dynamic]),
        );
        expect(after?.registry.instances).toHaveLength(3);
        expect(
          after?.registry.instances.find((instance) => instance.id === database)
            ?.initializationInputs,
        ).toEqual(databaseBefore.initializationInputs);
        expect(after?.security.jwt.expirySeconds).toBe(7_200);
        expect(after?.listeners.api).toEqual({ enabled: true, address: "127.0.0.1", port: 25_123 });
        expect(after?.secrets[AUTH_JWT_SECRET_SLOT]?.value).toBe("new-jwt");
        expect(stops.map((input) => input.instance.id)).toEqual(
          expect.arrayContaining([database, rest]),
        );
        expect(starts.map((input) => input.instance.id)).toEqual(
          expect.arrayContaining([database]),
        );
        expect(starts.map((input) => input.instance.id)).not.toContain(rest);
        expect(starts.map((input) => input.instance.id)).not.toContain(functions);
        expect(starts.map((input) => input.instance.id)).not.toContain(dynamic);
      }),
    ),
  );

  it.live("keeps disabled defaults stopped and lazy defaults dormant", () =>
    withFixture(({ endpoint, stackId, read, database, rest, functions, dynamic, starts }) =>
      Effect.gen(function* () {
        yield* withRpc({ endpoint, stackId }, (rpc) => rpc.restart({ config: validConfig }));
        const startedIds = starts.map((input) => input.instance.id);
        expect(startedIds).toContain(database);
        expect(startedIds).not.toContain(rest);
        expect(startedIds).not.toContain(functions);
        expect(startedIds).not.toContain(dynamic);
        expect(
          (yield* read())?.registry.instances.find((instance) => instance.id === functions)?.intent,
        ).toBe("stopped");
      }),
    ),
  );

  it.live("retains saved endpoint intent when whole restart omits listeners", () =>
    withFixture(({ endpoint, stackId, read, database }) =>
      Effect.gen(function* () {
        const before = yield* read();
        const saved = before?.registry.instances.find((instance) => instance.id === database);
        if (saved === undefined)
          return yield* new StackLifecycleConflictError({ message: "database missing" });
        yield* withRpc({ endpoint, stackId }, (rpc) => rpc.restart({ config: {} }));
        const after = yield* read();
        const restarted = after?.registry.instances.find((instance) => instance.id === database);
        expect(restarted?.config.endpoints).toEqual(saved.config.endpoints);
        expect(after?.listeners.api).toEqual({ enabled: true, address: "127.0.0.1" });
        expect(after?.ports).toEqual(
          expect.arrayContaining([
            {
              owner: "stack",
              binding: "api",
              address: "127.0.0.1",
              port: 25_123,
              intent: "automatic",
            },
          ]),
        );
      }),
    ),
  );

  it.live("removes the saved API listener when whole restart disables it", () =>
    withFixture(({ endpoint, stackId, read }) =>
      Effect.gen(function* () {
        const result = yield* withRpc({ endpoint, stackId }, (rpc) =>
          rpc.restart({ config: { listeners: { api: { enabled: false } } } }),
        );
        expect(result.endpoints.api).toBeUndefined();
        const after = yield* read();
        expect(after?.listeners.api).toEqual({ enabled: false });
        expect(after?.ports).toEqual(
          expect.not.arrayContaining([expect.objectContaining({ owner: "stack", binding: "api" })]),
        );
      }),
    ),
  );
});
