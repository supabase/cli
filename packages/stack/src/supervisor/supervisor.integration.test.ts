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
  StackNotRunningError,
  StackReconciliationError,
  StackStateInvalidError,
  StackUpgradeRequiredError,
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
import type { SupervisorIngress, SupervisorIngressReservation } from "./Ingress.ts";

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

const makeMockIngress = (
  timeline: Ref.Ref<ReadonlyArray<string>>,
  failOpen = false,
): SupervisorIngress => {
  let latest: SupervisorIngressReservation | undefined;
  let openedGeneration: number | undefined;
  return {
    acquire: (input) =>
      Effect.gen(function* () {
        if (latest?.generation === input.generation) {
          yield* Ref.update(timeline, (current) => [
            ...current,
            `acquire:cached:${input.generation}`,
          ]);
          return { ...latest, fresh: false };
        }
        const reservation: SupervisorIngressReservation = {
          assignments: {},
          privateAssignments: [],
          hostListeners: [],
          generation: input.generation,
          fresh: true,
        };
        latest = reservation;
        openedGeneration = undefined;
        yield* Ref.update(timeline, (current) => [...current, `acquire:${input.generation}`]);
        return reservation;
      }),
    open: (input, reservation) =>
      Effect.gen(function* () {
        if (openedGeneration === reservation.generation) {
          yield* Ref.update(timeline, (current) => [
            ...current,
            `open:cached:${reservation.generation}`,
          ]);
          return;
        }
        yield* Ref.update(timeline, (current) => [...current, `open:${input.generation}`]);
        if (failOpen)
          return yield* new GatewayActivationError({ message: "injected ingress open failure" });
        openedGeneration = reservation.generation;
      }),
    close: Effect.gen(function* () {
      yield* Ref.update(timeline, (current) => [...current, "close"]);
      latest = undefined;
      openedGeneration = undefined;
    }),
  };
};

const makeFixture = (
  fixtureOptions: {
    readonly ingress?: SupervisorIngress;
    readonly timeline?: Ref.Ref<ReadonlyArray<string>>;
    readonly runtime?: StackRuntime;
    readonly prepareOutcome?: "cached" | "downloaded" | "present" | "pulled";
    readonly startGate?: Deferred.Deferred<void>;
    readonly startStarted?: Deferred.Deferred<void>;
    readonly activationGate?: Deferred.Deferred<void>;
    readonly activationStarted?: Deferred.Deferred<void>;
    readonly activationCalls?: Ref.Ref<number>;
    readonly activationFailFirst?: Ref.Ref<boolean>;
    readonly preflightFailFirst?: Ref.Ref<boolean>;
    readonly preflightGate?: Deferred.Deferred<void>;
    readonly preflightStarted?: Deferred.Deferred<void>;
    readonly stopGate?: Deferred.Deferred<void>;
    readonly stopStarted?: Deferred.Deferred<void>;
    readonly destroyGate?: Deferred.Deferred<void>;
    readonly destroyStarted?: Deferred.Deferred<void>;
    readonly recoveryFailFirst?: Ref.Ref<boolean>;
    readonly recoveryStarted?: Deferred.Deferred<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-supervisor-" });
    const id = yield* deriveStackId(identity);
    const store = yield* makeStackStateStore({ stateRoot: root });
    yield* store.initialize(id, {
      format: "supabase-stack-state-v1",
      identity: { ...identity, stackId: id },
      runtime: fixtureOptions.runtime ?? { kind: "native" },
      desiredGeneration: 0,
      portsGeneration: null,
      desiredLifecycle: "unconfigured",
      ports: [],
      privatePorts: [],
      secrets: {},
    });
    const resources = yield* Ref.make<ReadonlyArray<ObservedWorkload>>([]);
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const logOptions = yield* Ref.make<ReadonlyArray<LogOptions | undefined>>([]);
    const failDestroy = yield* Ref.make(false);
    const driver: RuntimeDriver = {
      observe: () => Ref.get(resources),
      start: (key, workload: PlannedWorkload) =>
        Effect.gen(function* () {
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
          const ready = { ...key, state: "ready" as const };
          yield* Ref.update(resources, (current) => [
            ...current.filter((entry) => entry.workloadId !== key.workloadId),
            ready,
          ]);
          return ready;
        }),
      stop: (key) =>
        Effect.gen(function* () {
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
          if (!destroy && fixtureOptions.stopStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.stopStarted, undefined);
          if (!destroy && fixtureOptions.stopGate !== undefined)
            yield* Deferred.await(fixtureOptions.stopGate);
          yield* Ref.set(resources, []);
        }),
      recover: () =>
        Effect.gen(function* () {
          if (fixtureOptions.recoveryStarted !== undefined)
            yield* Deferred.succeed(fixtureOptions.recoveryStarted, undefined);
          if (fixtureOptions.recoveryFailFirst !== undefined) {
            const fail = yield* Ref.get(fixtureOptions.recoveryFailFirst);
            if (fail) {
              yield* Ref.set(fixtureOptions.recoveryFailFirst, false);
              return yield* new RuntimeDriverError({ message: "injected recovery failure" });
            }
          }
          return yield* Ref.get(resources);
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
        Effect.forEach(workloads, (workload) =>
          Ref.update(calls, (current) => [...current, `prepare:${workload.id}`]).pipe(
            Effect.as({
              workloadId: workload.id,
              capability: workload.capability,
              version: "test",
              outcome: fixtureOptions.prepareOutcome ?? "cached",
            }),
          ),
        ),
      preflight: () =>
        Effect.gen(function* () {
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
          return {};
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
      ...(fixtureOptions.ingress === undefined ? {} : { ingress: fixtureOptions.ingress }),
      logStore: {
        path: "memory://logs",
        append: () => Effect.succeed(entry),
        read: () => Effect.succeed([entry]),
        retained: () => Effect.succeed([entry]),
        stream: (options) =>
          Stream.unwrap(
            Ref.update(logOptions, (current) => [...current, options]).pipe(
              Effect.map(() => Stream.succeed(entry)),
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

  it.live("maps present and pulled container workloads to cached and pulled outcomes", () =>
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
          prepareOutcome: "present",
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
        const status = yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        expect(status.lifecycle).toBe("running");
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("ready");
        expect(yield* Ref.get(fixture.calls)).toContain("start:database:database");
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
          .replace(
            fixture.id,
            {
              ...running,
              ports: [
                { field: "api", port: 55433, intent: "exact" },
                { field: "database", port: 55432, intent: "exact" },
              ] as const,
              portsGeneration: running.desiredGeneration,
            },
            running.desiredGeneration,
          )
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
          portsGeneration: running.desiredGeneration,
          secrets: {
            ...running.secrets,
            "secret:database.internal.password": {
              policy: "managed" as const,
              value: "p@ss:word",
            },
          },
        };
        yield* fixture.store
          .replace(fixture.id, state, running.desiredGeneration)
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
          portsGeneration: running.desiredGeneration,
        };
        yield* fixture.store
          .replace(fixture.id, state, running.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        const credentials = yield* invokeCredentials(fixture.supervisor);
        expect(credentials.storage).toBeUndefined();
      }),
    ),
  );

  it.live("rejects credentials when the durable generation or phase is not running", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        const stale = {
          ...running,
          ports: [{ field: "database", port: 55432, intent: "exact" as const }] as const,
          portsGeneration: running.desiredGeneration - 1,
        };
        yield* fixture.store
          .replace(fixture.id, stale, running.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        const staleExit = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(staleExit)).toEqual(
          expect.objectContaining({ tag: "StackNotRunningError" }),
        );
        const stopped = {
          ...stale,
          portsGeneration: stale.desiredGeneration,
          desiredLifecycle: "stopped" as const,
        };
        yield* fixture.store
          .replace(fixture.id, stopped, stale.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        const stoppedExit = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(stoppedExit)).toEqual(
          expect.objectContaining({ tag: "StackNotRunningError" }),
        );
      }),
    ),
  );

  it.live("fails closed when a persisted running generation is newer than this owner", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        const advancedGeneration = running.desiredGeneration + 1;
        yield* fixture.store
          .replace(
            fixture.id,
            {
              ...running,
              desiredGeneration: advancedGeneration,
              portsGeneration: advancedGeneration,
            },
            running.desiredGeneration,
          )
          .pipe(Effect.provideContext(fixture.context));
        const staleOwnerExit = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(staleOwnerExit)).toEqual(
          expect.objectContaining({ tag: "StackNotRunningError" }),
        );
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
          portsGeneration: running.desiredGeneration,
        };
        yield* fixture.store
          .replace(fixture.id, state, running.desiredGeneration)
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
        yield* fixture.store
          .replace(fixture.id, missingSecret, state.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        const missingExit = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(missingExit)).toEqual(
          expect.objectContaining({ tag: "StackSecretMismatchError" }),
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
          .replace(fixture.id, storageSecretMissing, state.desiredGeneration)
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
          .replace(fixture.id, missingApiListener, state.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        const listenerExit = yield* invokeCredentials(fixture.supervisor).pipe(Effect.exit);
        expect(errorOf(listenerExit)).toEqual(
          expect.objectContaining({ tag: "StackNotRunningError" }),
        );
      }),
    ),
  );

  it.live("acknowledges quiesce only after runtime cleanup", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const response = yield* fixture.supervisor.maintenanceHandlers.quiesce;
        expect(response.ok).toBe(true);
        expect(yield* Ref.get(fixture.calls)).toContain("cleanup:stop");
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

  it.live("keeps running state and explicit restart guidance for changed start input", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const failed = yield* fixture.supervisor
          .start({ config: { capabilities: { rest: { settings: { schemas: ["private"] } } } } })
          .pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(StackUpgradeRequiredError);
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
        expect(yield* Ref.get(fixture.calls)).toEqual(["start:database:database"]);
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
        const config = { capabilities: { rest: {} } };
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
        expect(Exit.isSuccess(secondExit)).toBe(true);
      }),
    ),
  );

  it.live("single-flights lazy activation and retains its endpoint for the generation", () =>
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

  it.live("fences activation against a concurrent stop generation", () =>
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

  it.live("completes accepted quiesce after its waiter is interrupted", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const waiter = yield* Effect.forkChild(fixture.supervisor.maintenanceHandlers.quiesce);
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

  it.live("recovers a running durable intent and starts missing eager workloads", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const recoveredResources = yield* Ref.make<ReadonlyArray<ObservedWorkload>>([]);
        const recovered = yield* makeSupervisor({
          identity,
          stackId: fixture.id,
          ownerSessionId: "replacement-owner",
          rpcRelease: "test-release",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: {
            driver: {
              observe: () => Ref.get(recoveredResources),
              start: (key) =>
                Effect.gen(function* () {
                  const ready = { ...key, state: "ready" as const };
                  yield* Ref.update(recoveredResources, (current) => [
                    ...current.filter((entry) => entry.workloadId !== key.workloadId),
                    ready,
                  ]);
                  return ready;
                }),
              stop: (key) =>
                Ref.update(recoveredResources, (current) =>
                  current.filter((entry) => entry.workloadId !== key.workloadId),
                ),
              remove: (key) =>
                Ref.update(recoveredResources, (current) =>
                  current.filter((entry) => entry.workloadId !== key.workloadId),
                ),
              cleanup: () => Ref.set(recoveredResources, []),
              recover: () =>
                Ref.update(fixture.calls, (current) => [...current, "recover"]).pipe(Effect.as([])),
            },
          },
        });
        yield* recovered.recover;
        const status = yield* recovered.status;
        expect(status.desiredLifecycle).toBe("running");
        expect(status.lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.calls)).toContain("recover");
      }),
    ),
  );

  it.live("skips stale deferred recovery after restart adopts a newer generation", () =>
    run(
      Effect.gen(function* () {
        const stopGate = yield* Deferred.make<void>();
        const stopStarted = yield* Deferred.make<void>();
        const fixture = yield* makeFixture({ stopGate, stopStarted });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const recovered = yield* makeSupervisor({
          identity,
          stackId: fixture.id,
          ownerSessionId: "deferred-recovery-owner",
          rpcRelease: "test-release",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: fixture.runtime,
        });
        const restart = yield* Effect.forkChild(recovered.restart());
        yield* Deferred.await(stopStarted);
        const recover = yield* Effect.forkChild(recovered.recover);
        yield* Deferred.succeed(stopGate, undefined);
        yield* Fiber.join(restart);
        yield* Fiber.join(recover);
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        expect(running.desiredLifecycle).toBe("running");
        expect(running.desiredGeneration).toBe(3);
        const withCredentials = {
          ...running,
          ports: [
            { field: "api", port: 55433, intent: "exact" as const },
            { field: "database", port: 55432, intent: "exact" as const },
          ] as const,
          portsGeneration: running.desiredGeneration,
        };
        yield* fixture.store
          .replace(fixture.id, withCredentials, running.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        expect((yield* recovered.status).lifecycle).toBe("running");
        const credentials = yield* invokeCredentials(recovered);
        expect(Redacted.value(credentials.database.password)).toEqual(expect.any(String));
      }),
    ),
  );

  it.live("keeps an owner attachable until persisted plan recovery validates", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const running = yield* fixture.store
          .read(fixture.id)
          .pipe(Effect.provideContext(fixture.context));
        if (running === undefined || running.definition === undefined)
          return yield* new StackStateInvalidError({ message: "running fixture state is missing" });
        const invalid = {
          ...running,
          definition: {
            ...running.definition,
            capabilities: {
              ...running.definition.capabilities,
              rest: { ...running.definition.capabilities.rest, version: "unsupported" },
            },
          },
        };
        yield* fixture.store
          .replace(fixture.id, invalid, running.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        const recovered = yield* makeSupervisor({
          identity,
          stackId: fixture.id,
          ownerSessionId: "replacement-owner",
          rpcRelease: "test-release",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: {
            driver: {
              observe: () => Effect.succeed([]),
              start: (key) => Effect.succeed({ ...key, state: "ready" as const }),
              stop: () => Effect.void,
              remove: () => Effect.void,
              cleanup: () => Effect.void,
              recover: () => Effect.succeed([]),
            },
          },
        });
        expect((yield* recovered.status).lifecycle).toBe("starting");
        yield* recovered.recover;
        const status = yield* recovered.status;
        expect(status.lifecycle).toBe("stopped");
        expect(status.capabilities.find(({ name }) => name === "rest")?.state).toBe("failed");
      }),
    ),
  );

  it.live("exposes recovery failure in status and permits a retry", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const failFirst = yield* Ref.make(true);
        const recoverCalls = yield* Ref.make(0);
        const activationCalls = yield* Ref.make(0);
        const startCalls = yield* Ref.make(0);
        const recoveredResources = yield* Ref.make<ReadonlyArray<ObservedWorkload>>([]);
        const recovered = yield* makeSupervisor({
          identity,
          stackId: fixture.id,
          ownerSessionId: "recovery-owner",
          rpcRelease: "test-release",
          stateStore: fixture.store,
          context: fixture.context,
          runtime: {
            driver: {
              observe: () => Ref.get(recoveredResources),
              start: (key) =>
                Effect.gen(function* () {
                  yield* Ref.update(startCalls, (count) => count + 1);
                  const ready = { ...key, state: "ready" as const };
                  yield* Ref.update(recoveredResources, (current) => [
                    ...current.filter((entry) => entry.workloadId !== key.workloadId),
                    ready,
                  ]);
                  return ready;
                }),
              stop: (key) =>
                Ref.update(recoveredResources, (current) =>
                  current.filter((entry) => entry.workloadId !== key.workloadId),
                ),
              remove: (key) =>
                Ref.update(recoveredResources, (current) =>
                  current.filter((entry) => entry.workloadId !== key.workloadId),
                ),
              cleanup: () => Ref.set(recoveredResources, []),
              recover: () =>
                Effect.gen(function* () {
                  yield* Ref.update(recoverCalls, (count) => count + 1);
                  if (yield* Ref.get(failFirst)) {
                    yield* Ref.set(failFirst, false);
                    return yield* new RuntimeDriverError({ message: "injected recovery failure" });
                  }
                  return [];
                }),
            },
            activate: () =>
              Ref.update(activationCalls, (count) => count + 1).pipe(
                Effect.andThen(Effect.succeed({ host: "127.0.0.1", port: 9999 })),
              ),
          },
        });
        yield* recovered.recover;
        const failedStatus = yield* recovered.status;
        expect(failedStatus.lifecycle).toBe("stopped");
        expect(failedStatus.capabilities.find(({ name }) => name === "rest")?.state).toBe("failed");
        const activation = yield* recovered.activate("rest").pipe(Effect.exit);
        expect(Exit.isFailure(activation)).toBe(true);
        expect(errorOf(activation)).toBeInstanceOf(StackNotRunningError);
        expect(yield* Ref.get(activationCalls)).toBe(0);
        expect(yield* Ref.get(startCalls)).toBe(0);
        const failedGeneration = failedStatus.desiredGeneration;
        yield* recovered.recover;
        const retriedStatus = yield* recovered.status;
        expect(retriedStatus.lifecycle).toBe("running");
        expect(retriedStatus.desiredGeneration).toBe(failedGeneration);
        expect(yield* Ref.get(recoverCalls)).toBe(2);
      }),
    ),
  );

  it.live("projects observed workload errors into failed capability status", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              database: {},
              rest: { enabled: false },
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
        yield* Ref.set(fixture.resources, [
          {
            stackId: fixture.id,
            desiredGeneration: 1,
            workloadId: "database:database",
            specHash: "test",
            state: "failed",
            error: "native process exited with code 3",
          },
        ]);
        const status = yield* fixture.supervisor.status;
        expect(status.lifecycle).toBe("stopped");
        expect(status.capabilities.find(({ name }) => name === "database")).toMatchObject({
          state: "failed",
          error: "native process exited with code 3",
        });
      }),
    ),
  );

  it.live("acquires ingress before eager workloads and opens it after readiness", () =>
    run(
      Effect.gen(function* () {
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const fixture = yield* makeFixture({
          timeline,
          ingress: makeMockIngress(timeline),
        });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        const events = yield* Ref.get(timeline);
        expect(events.indexOf("acquire:1")).toBeGreaterThanOrEqual(0);
        expect(events.indexOf("start:database:database")).toBeGreaterThan(0);
        expect(events.indexOf("open:1")).toBeGreaterThan(events.indexOf("start:rest:rest"));
      }),
    ),
  );

  it.live("reserves and opens a database listener when the API listener is disabled", () =>
    run(
      Effect.gen(function* () {
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const fixture = yield* makeFixture({
          timeline,
          ingress: makeMockIngress(timeline),
        });
        yield* fixture.supervisor.start({
          config: {
            capabilities: {
              database: {},
              rest: { enabled: false },
              auth: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
            listeners: { api: { enabled: false } },
          },
        });
        const events = yield* Ref.get(timeline);
        expect(events).toContain("start:database:database");
        expect(events).toContain("acquire:1");
        expect(events).toContain("open:1");
      }),
    ),
  );

  it.live("keeps same-generation ingress identity on repeated start", () =>
    run(
      Effect.gen(function* () {
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const fixture = yield* makeFixture({
          timeline,
          ingress: makeMockIngress(timeline),
        });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* fixture.supervisor.start();
        const events = yield* Ref.get(timeline);
        expect(events.filter((event) => event === "acquire:1")).toHaveLength(1);
        expect(events).toContain("acquire:cached:1");
        expect(events).toContain("open:cached:1");
      }),
    ),
  );

  it.live("closes ingress before cleanup and reopens it for the next generation", () =>
    run(
      Effect.gen(function* () {
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const fixture = yield* makeFixture({
          timeline,
          ingress: makeMockIngress(timeline),
        });
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* fixture.supervisor.restart();
        const events = yield* Ref.get(timeline);
        const closeIndex = events.indexOf("close");
        const cleanupIndex = events.findIndex(
          (event, index) => index > closeIndex && event === "cleanup:stop",
        );
        expect(closeIndex).toBeGreaterThanOrEqual(0);
        expect(closeIndex).toBeLessThan(cleanupIndex);
        expect(events).toContain("acquire:3");
        expect(events).toContain("open:3");
      }),
    ),
  );

  it.live("closes a fresh ingress reservation when opening fails", () =>
    run(
      Effect.gen(function* () {
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const fixture = yield* makeFixture({
          timeline,
          ingress: makeMockIngress(timeline, true),
        });
        const failed = yield* fixture.supervisor
          .start({ config: { capabilities: { rest: {} } } })
          .pipe(Effect.exit);
        expect(errorOf(failed)).toBeInstanceOf(GatewayActivationError);
        const events = yield* Ref.get(timeline);
        expect(events).toEqual(
          expect.arrayContaining(["acquire:1", "start:database:database", "open:1", "close"]),
        );
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("running");
        expect((yield* fixture.supervisor.status).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("retains destroying state until exact data cleanup succeeds", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.supervisor.start({ config: { capabilities: { rest: {} } } });
        yield* Ref.set(fixture.failDestroy, true);
        const failed = yield* fixture.supervisor.destroy.pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* fixture.store.read(fixture.id))?.desiredLifecycle).toBe("destroying");
        yield* Ref.set(fixture.failDestroy, false);
        yield* fixture.supervisor.destroy;
        expect(yield* fixture.store.read(fixture.id)).toBeUndefined();
      }),
    ),
  );
});
