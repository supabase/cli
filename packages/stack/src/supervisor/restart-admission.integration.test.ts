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
  Path,
  Redacted,
  Ref,
  Stream,
} from "effect";
import { deriveStackId } from "../identity/Identity.ts";
import { compileServiceInstance, compileServiceRestart } from "../model/Compiler.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import type { RuntimeDriver } from "../runtime/RuntimeDriver.ts";
import { StackLifecycleConflictError, type StackError } from "../public/Errors.ts";
import type { ServiceRestartPayload } from "../public/Service.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makeStackStateStore, type StackStateStore } from "../state/StackStateStore.ts";
import { makeControlClient, startControlServer } from "../control/ControlServer.ts";
import { STACK_RPC_RELEASE, type StackRpcClient } from "../control/StackRpc.ts";
import type { InstanceRuntimeInput } from "./Lifecycle.ts";
import { makeSupervisor, type Supervisor, type SupervisorRuntime } from "./Supervisor.ts";
import type { InstanceRestartCandidate } from "./InstanceEngine.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import type { LogStore } from "./LogStore.ts";
import { ServiceInstanceIdSchema, type ServiceInstanceId } from "../public/ServiceInstanceId.ts";

const ingress: SupervisorIngress = {
  acquire: () => Effect.die("restart admission test does not open ingress"),
  open: () => Effect.die("restart admission test does not open ingress"),
  close: Effect.void,
};

const logStore: LogStore = {
  path: "/dev/null",
  append: () => Effect.die("restart admission test does not write logs"),
  read: () => Effect.succeed([]),
};

interface RuntimeTrace {
  readonly events: Array<string>;
  readonly starts: Array<InstanceRuntimeInput>;
  readonly stops: Array<InstanceRuntimeInput>;
}

interface Fixture {
  readonly supervisor: Supervisor;
  readonly stateStore: StackStateStore;
  readonly context: Context.Context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>;
  readonly stackId: string;
  readonly endpoint: { readonly kind: "unix"; readonly path: string };
  readonly database: ServiceInstanceId;
  readonly rest: ServiceInstanceId;
  readonly functions: ServiceInstanceId;
  readonly trace: RuntimeTrace;
  readonly databaseStartEntered: Deferred.Deferred<void>;
  readonly releaseDatabaseStart: Deferred.Deferred<void>;
  readonly pauseDatabaseStart: Ref.Ref<boolean>;
  readonly firstStopEntered: Deferred.Deferred<void>;
  readonly releaseFirstStop: Deferred.Deferred<void>;
  readonly read: () => Effect.Effect<PersistedStackState | undefined, StackError>;
}

interface FixtureOptions {
  readonly pauseDatabaseStart?: boolean;
  readonly pauseFirstStop?: boolean;
}

const withFixture = <A, E, R>(
  options: FixtureOptions,
  use: (fixture: Fixture) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-restart-admission-" });
      const projectRoot = path.join(root, "project");
      yield* fs.makeDirectory(projectRoot);
      const context = Context.make(FileSystem.FileSystem, fs).pipe(
        Context.add(Path.Path, path),
        Context.add(Crypto.Crypto, crypto),
      );
      const identity = {
        projectRoot,
        branchContext: "test",
        stackName: "restart-admission",
      } as const;
      const stackId = yield* deriveStackId(identity);
      const databaseId = ServiceInstanceIdSchema.make("11111111-1111-4111-8111-111111111111");
      const restId = ServiceInstanceIdSchema.make("22222222-2222-4222-8222-222222222222");
      const functionsId = ServiceInstanceIdSchema.make("33333333-3333-4333-8333-333333333333");
      const database = yield* compileServiceInstance(
        {
          service: "database",
          name: "primary",
          config: { password: Redacted.make("old-password"), settings: {} },
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
            signing: { kind: "symmetric", secret: { slot: "test-jwt" } },
          },
        },
        listeners: {},
        registry: {
          initialized: true,
          instances: [database.instance, rest.instance, functions.instance],
          defaultInstanceIds: {
            database: databaseId,
            rest: restId,
            functions: functionsId,
          },
        },
        ports: [],
        privatePorts: [],
        secrets: {
          "test-jwt": { policy: "managed", value: "test-jwt" },
          [`secret:${databaseId}:password`]: { policy: "managed", value: "old-password" },
        },
      };
      const stateStore = yield* makeStackStateStore({ stateRoot: path.join(root, "state") });
      yield* stateStore.initialize(stackId, state).pipe(Effect.provideContext(context));
      const trace: RuntimeTrace = { events: [], starts: [], stops: [] };
      const pauseDatabaseStart = yield* Ref.make(options.pauseDatabaseStart ?? false);
      const databaseStartEntered = yield* Deferred.make<void>();
      const releaseDatabaseStart = yield* Deferred.make<void>();
      const firstStopEntered = yield* Deferred.make<void>();
      const releaseFirstStop = yield* Deferred.make<void>();
      let firstStop = true;
      const driver: RuntimeDriver = {
        observe: () => Effect.succeed([]),
        start: () => Effect.die("restart admission test does not start driver workloads"),
        stop: () => Effect.die("restart admission test does not stop driver workloads"),
        remove: () => Effect.die("restart admission test does not remove driver workloads"),
        cleanup: () => Effect.die("restart admission test does not clean driver workloads"),
        wipePersistentData: () =>
          Effect.die("restart admission test does not wipe driver workloads"),
      };
      const runtime: SupervisorRuntime = {
        driver,
        preflight: () => Effect.void,
        prepare: () => Effect.succeed({ instances: [] }),
        prepareArtifacts: () => Effect.void,
        start: (input) =>
          Effect.gen(function* () {
            trace.starts.push(input);
            trace.events.push(`start:${input.instance.service}`);
            if (input.instance.id === databaseId && (yield* Ref.get(pauseDatabaseStart))) {
              yield* Deferred.succeed(databaseStartEntered, undefined);
              yield* Deferred.await(releaseDatabaseStart);
            }
            return [] as ReadonlyArray<RuntimeBindingPublication>;
          }),
        stop: (input) =>
          Effect.gen(function* () {
            trace.stops.push(input);
            trace.events.push(`stop:${input.instance.service}`);
            if (options.pauseFirstStop && firstStop) {
              firstStop = false;
              yield* Deferred.succeed(firstStopEntered, undefined);
              yield* Deferred.await(releaseFirstStop);
            }
          }),
        destroy: () => Effect.void,
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
        activate: () => Effect.die("restart admission test does not activate gateways"),
        ingress,
        logStore,
      };
      const supervisor = yield* makeSupervisor({
        stackId,
        ownerSessionId: "restart-admission-owner",
        stateStore,
        context,
        runtime,
      }).pipe(Effect.provideContext(context));
      const endpoint = { kind: "unix" as const, path: path.join(root, "control", "owner.sock") };
      yield* startControlServer({
        stackId,
        ownerSessionId: "restart-admission-owner",
        endpoint,
        rpcRelease: STACK_RPC_RELEASE,
        maintenanceHandlers: supervisor.maintenanceHandlers,
        rpcHandlers: supervisor.rpcHandlers,
      });
      return yield* use({
        supervisor,
        stateStore,
        context,
        stackId,
        endpoint,
        database: databaseId,
        rest: restId,
        functions: functionsId,
        trace,
        databaseStartEntered,
        releaseDatabaseStart,
        pauseDatabaseStart,
        firstStopEntered,
        releaseFirstStop,
        read: () => stateStore.read(stackId).pipe(Effect.provideContext(context)),
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const databaseUpdate = (id: ServiceInstanceId, password: string): ServiceRestartPayload => ({
  id,
  service: "database",
  config: { password: Redacted.make(password), settings: {} },
});

const invalidSelectedUpdate = (id: ServiceInstanceId): ServiceRestartPayload => ({
  id,
  service: "functions",
  config: { settings: {} },
});

const withRpc = <A, E>(
  fixture: Pick<Fixture, "endpoint" | "stackId">,
  use: (rpc: StackRpcClient) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    makeControlClient(fixture.endpoint, {
      stackId: fixture.stackId,
      ownerSessionId: "restart-admission-owner",
      rpcRelease: STACK_RPC_RELEASE,
    }).rpc.pipe(Effect.flatMap(use)),
  );

describe("restart admission", { timeout: 30_000 }, () => {
  it.live("rejects an invalid later update without mutating the admitted selection", () =>
    withFixture({}, ({ endpoint, stackId, read, database, functions, trace }) =>
      Effect.gen(function* () {
        const before = yield* read();
        const failed = yield* Effect.exit(
          withRpc({ endpoint, stackId }, (rpc) =>
            rpc.restart({
              services: [database, functions],
              updates: [databaseUpdate(database, "new-password"), invalidSelectedUpdate(database)],
            }),
          ),
        );
        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* read()).toEqual(before);
        expect(trace.events).toEqual([]);
      }),
    ),
  );

  it.live("passes the old state to stop and the new secret to start", () =>
    withFixture({}, ({ endpoint, stackId, read, database, trace }) =>
      Effect.gen(function* () {
        const result = yield* withRpc({ endpoint, stackId }, (rpc) =>
          rpc.serviceRestart(databaseUpdate(database, "new-password")),
        );
        expect(result.phase).toBe("ready");
        const stopped = trace.stops.find((input) => input.instance.id === database);
        const started = trace.starts.find((input) => input.instance.id === database);
        expect(stopped?.state.secrets[`secret:${database}:password`]?.value).toBe("old-password");
        expect(started?.state.secrets[`secret:${database}:password`]?.value).toBe("new-password");
        const after = yield* read();
        const persisted = after?.registry.instances.find((instance) => instance.id === database);
        expect(persisted?.revisions.config).toBe(1);
        expect(after?.secrets[`secret:${database}:password`]?.value).toBe("new-password");
      }),
    ),
  );

  it.live("keeps dependency order while an independent Functions restart completes", () =>
    withFixture(
      {},
      ({
        supervisor,
        endpoint,
        stackId,
        database,
        rest,
        functions,
        trace,
        databaseStartEntered,
        releaseDatabaseStart,
        pauseDatabaseStart,
      }) =>
        Effect.gen(function* () {
          yield* supervisor.start({ services: [database, rest, functions] });
          trace.events.length = 0;
          trace.starts.length = 0;
          trace.stops.length = 0;
          yield* Ref.set(pauseDatabaseStart, true);
          const observingFunctions = yield* Deferred.make<void>();
          const functionsReady = yield* supervisor.instances.followStatus(functions).pipe(
            Stream.tap(() => Deferred.succeed(observingFunctions, undefined)),
            Stream.filter(
              (status) =>
                status.phase === "ready" &&
                status.pendingOperation === undefined &&
                trace.starts.some((input) => input.instance.id === functions),
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(observingFunctions);
          const restart = yield* Effect.forkChild(
            withRpc({ endpoint, stackId }, (rpc) =>
              rpc.restart({
                services: [database, rest, functions],
                updates: [databaseUpdate(database, "old-password")],
              }),
            ),
            { startImmediately: true },
          );
          yield* Deferred.await(databaseStartEntered).pipe(Effect.timeout("5 seconds"));
          yield* Fiber.join(functionsReady).pipe(Effect.timeout("5 seconds"));
          expect(trace.events).toContain("stop:rest");
          expect(trace.events.indexOf("stop:rest")).toBeLessThan(
            trace.events.indexOf("stop:database"),
          );
          expect(trace.events).toContain("start:functions");
          expect(trace.events).not.toContain("start:rest");
          yield* Deferred.succeed(releaseDatabaseStart, undefined);
          yield* Fiber.join(restart);
          expect(trace.events.indexOf("start:database")).toBeLessThan(
            trace.events.indexOf("start:rest"),
          );
        }).pipe(Effect.ensuring(Deferred.succeed(releaseDatabaseStart, undefined))),
    ),
  );

  it.live("does not strand later members when the restart caller is interrupted", () =>
    withFixture(
      { pauseFirstStop: true },
      ({
        supervisor,
        context,
        database,
        functions,
        trace,
        firstStopEntered,
        releaseFirstStop,
        read,
      }) =>
        Effect.gen(function* () {
          const before = yield* read();
          if (before === undefined) throw new Error("restart fixture state is missing");
          const currentDatabase = before.registry.instances.find(
            (instance) => instance.id === database,
          );
          const currentFunctions = before.registry.instances.find(
            (instance) => instance.id === functions,
          );
          if (currentDatabase === undefined || currentFunctions === undefined)
            throw new Error("restart fixture instances are missing");
          const nextDatabase = yield* compileServiceRestart(
            currentDatabase,
            { password: Redacted.make("old-password"), settings: {} },
            {
              projectRoot: before.identity.projectRoot,
              path: yield* Path.Path,
              runtime: before.runtime,
            },
          ).pipe(Effect.provideContext(context));
          const nextFunctions = yield* compileServiceRestart(
            currentFunctions,
            { settings: {} },
            {
              projectRoot: before.identity.projectRoot,
              path: yield* Path.Path,
              runtime: before.runtime,
            },
          ).pipe(Effect.provideContext(context));
          const candidates: ReadonlyArray<InstanceRestartCandidate> = [
            {
              instance: nextDatabase.instance,
              secretSlots: nextDatabase.secretSlots,
              previous: { state: before, instance: currentDatabase },
            },
            {
              instance: nextFunctions.instance,
              secretSlots: nextFunctions.secretSlots,
              previous: { state: before, instance: currentFunctions },
            },
          ];
          const settled = yield* supervisor.followStatus.pipe(
            Stream.filter((status) =>
              status.instances
                .filter(({ id }) => id === database || id === functions)
                .every(
                  ({ phase, pendingOperation }) =>
                    phase === "ready" && pendingOperation === undefined,
                ),
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          const restart = yield* Effect.forkChild(supervisor.instances.restartAll(candidates), {
            startImmediately: true,
          });
          yield* Deferred.await(firstStopEntered).pipe(Effect.timeout("5 seconds"));
          const _interruption = yield* Effect.forkChild(Fiber.interrupt(restart), {
            startImmediately: true,
          });
          yield* Deferred.succeed(releaseFirstStop, undefined);
          yield* Fiber.join(settled).pipe(Effect.timeout("5 seconds"));
          const state = yield* read();
          expect(
            state?.registry.instances
              .filter((instance) => instance.id === database || instance.id === functions)
              .map((instance) => instance.pendingOperation),
          ).toEqual([null, null]);
          expect(trace.starts.map((input) => input.instance.id)).toEqual(
            expect.arrayContaining([database, functions]),
          );
        }),
    ),
  );
});
