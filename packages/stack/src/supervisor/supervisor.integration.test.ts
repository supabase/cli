import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path, Redacted, Ref, Stream } from "effect";
import type { LogOptions, StackLogEntry } from "../public/Logs.ts";
import {
  GatewayActivationError,
  StackNotRunningError,
  StackStateInvalidError,
  StackUpgradeRequiredError,
} from "../public/Errors.ts";
import {
  RuntimeDriverError,
  type RuntimeDriver,
  type ObservedWorkload,
} from "../runtime/RuntimeDriver.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import { deriveStackId } from "../identity/Identity.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { makeSupervisor, type SupervisorRuntime } from "./Supervisor.ts";
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
      runtime: { kind: "native" },
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
          yield* Ref.set(resources, []);
        }),
      recover: () => Ref.get(resources),
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
      preflight: () => Effect.succeed({}),
      activate: () => Effect.succeed({ host: "127.0.0.1", port: 9999 }),
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
    return { supervisor, calls, logOptions, failDestroy, context, store, id };
  });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("Supervisor composition", () => {
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
              ],
              portsGeneration: running.desiredGeneration,
            },
            running.desiredGeneration,
          )
          .pipe(Effect.provideContext(fixture.context));
        const credentials = yield* fixture.supervisor.rpcHandlers.credentials();
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
        expect(Redacted.value(credentials.storage?.secretAccessKey)).toBe(
          "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
        );
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
          ],
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
        const credentials = yield* fixture.supervisor.rpcHandlers.credentials();
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
          ],
          portsGeneration: running.desiredGeneration,
        };
        yield* fixture.store
          .replace(fixture.id, state, running.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        const credentials = yield* fixture.supervisor.rpcHandlers.credentials();
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
          ports: [{ field: "database", port: 55432, intent: "exact" as const }],
          portsGeneration: running.desiredGeneration - 1,
        };
        yield* fixture.store
          .replace(fixture.id, stale, running.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        const staleExit = yield* fixture.supervisor.rpcHandlers.credentials().pipe(Effect.exit);
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
        const stoppedExit = yield* fixture.supervisor.rpcHandlers.credentials().pipe(Effect.exit);
        expect(errorOf(stoppedExit)).toEqual(
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
          ],
          portsGeneration: running.desiredGeneration,
        };
        yield* fixture.store
          .replace(fixture.id, state, running.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        const authDisabled = yield* fixture.supervisor.rpcHandlers.credentials().pipe(Effect.exit);
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
        const missingExit = yield* fixture.supervisor.rpcHandlers.credentials().pipe(Effect.exit);
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
        const storageExit = yield* fixture.supervisor.rpcHandlers.credentials().pipe(Effect.exit);
        expect(errorOf(storageExit)).toEqual(
          expect.objectContaining({ tag: "StackSecretMismatchError" }),
        );
        const complete = { ...missingSecret, secrets: baseSecrets };
        const missingApiListener = {
          ...complete,
          ports: [{ field: "database", port: 55432, intent: "exact" as const }],
        };
        yield* fixture.store
          .replace(fixture.id, missingApiListener, state.desiredGeneration)
          .pipe(Effect.provideContext(fixture.context));
        const listenerExit = yield* fixture.supervisor.rpcHandlers.credentials().pipe(Effect.exit);
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
        const status = yield* recovered.status;
        expect(status.desiredLifecycle).toBe("running");
        expect(status.lifecycle).toBe("running");
        expect(yield* Ref.get(fixture.calls)).toContain("recover");
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
