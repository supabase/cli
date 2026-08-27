import { describe, expect, it } from "@effect/vitest";
import { layer as BunChildProcessSpawnerLayer } from "@effect/platform-bun/BunChildProcessSpawner";
import { layer as BunFileSystemLayer } from "@effect/platform-bun/BunFileSystem";
import { layer as BunPathLayer } from "@effect/platform-bun/BunPath";
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Option, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { buildGraph } from "./DependencyGraph.ts";
import { LogBuffer } from "./LogBuffer.ts";
import { Orchestrator } from "./Orchestrator.ts";
import type { ServiceState } from "./ServiceState.ts";
import type { ProbeConfig, ServiceDef } from "./ServiceDef.ts";

const spawnerLayer = BunChildProcessSpawnerLayer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystemLayer, BunPathLayer)),
);

const deps = Layer.mergeAll(spawnerLayer, LogBuffer.layer, FetchHttpClient.layer);

function setupReal(defs: ReadonlyArray<ServiceDef>) {
  const graph = Effect.runSync(buildGraph(defs));
  const layer = Orchestrator.layer(graph).pipe(Layer.provide(deps));
  return { graph, layer };
}

const isUp = (status: string) => status === "Running" || status === "Healthy";

const fileExistsProbe = (path: string) =>
  ({
    _tag: "Exec" as const,
    command: "test",
    args: ["-f", path],
  }) satisfies ProbeConfig;

type StateReader = {
  readonly getAllStates: Effect.Effect<ReadonlyArray<ServiceState>>;
  readonly allStateChanges: Stream.Stream<ServiceState>;
};

const waitForStatuses = (
  orc: StateReader,
  predicates: ReadonlyArray<{
    readonly name: string;
    readonly predicate: (state: ServiceState) => boolean;
  }>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* orc.getAllStates;
    const matches = (states: ReadonlyArray<ServiceState>) =>
      predicates.every(({ name, predicate }) => {
        const state = states.find((candidate) => candidate.name === name);
        return state !== undefined && predicate(state);
      });
    if (matches(current)) return;

    yield* orc.allStateChanges.pipe(
      Stream.scan(new Map(current.map((state) => [state.name, state])), (states, state) =>
        new Map(states).set(state.name, state),
      ),
      Stream.filter((states) => matches([...states.values()])),
      Stream.take(1),
      Stream.runDrain,
    );
  });

describe("Orchestrator integration", () => {
  it.live(
    "serializes a concurrent start and stop lifecycle command",
    () => {
      const defs: ServiceDef[] = [
        {
          name: "serialized",
          command: "sh",
          args: ["-c", "trap '' TERM; sleep 60"],
          shutdown: { signal: "SIGTERM", timeoutSeconds: 0.5 },
        },
      ];
      const { layer } = setupReal(defs);

      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        const changes = yield* orc.stateChanges("serialized");
        const running = yield* changes.pipe(
          Stream.filter((state) => isUp(state.status)),
          Stream.take(1),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* orc.start();
        yield* Fiber.join(running);

        const stopping = yield* changes.pipe(
          Stream.filter((state) => state.status === "Stopping"),
          Stream.take(1),
          Stream.runHead,
          Effect.forkChild,
        );
        const events: Array<string> = [];
        const startEntered = yield* Deferred.make<void>();
        const stop = orc.stop.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              events.push("stop");
            }),
          ),
        );
        const stopFiber = yield* Effect.forkChild(stop, { startImmediately: true });
        yield* Fiber.join(stopping);

        const startFiber = yield* Effect.forkChild(
          orc.startService("serialized", {
            beforeStart: () =>
              Effect.sync(() => events.push("start")).pipe(
                Effect.andThen(Deferred.succeed(startEntered, void 0)),
              ),
          }),
          { startImmediately: true },
        );
        yield* Fiber.join(stopFiber);
        yield* Fiber.join(startFiber);
        const startResult = yield* Deferred.await(startEntered).pipe(
          Effect.timeoutOption(Duration.seconds(2)),
        );
        expect(Option.isSome(startResult)).toBe(true);

        expect(events).toEqual(["stop", "start"]);
        yield* orc.stop;
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "starts services in dependency order (A before B)",
    () => {
      const defs: ServiceDef[] = [
        {
          name: "service-a",
          command: "sh",
          args: ["-c", "echo service-a-started && sleep 60"],
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
        },
        {
          name: "service-b",
          command: "sh",
          args: ["-c", "echo service-b-started && sleep 60"],
          dependencies: [{ service: "service-a", condition: "started" }],
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
        },
      ];

      const { layer } = setupReal(defs);

      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();

        yield* waitForStatuses(orc, [
          { name: "service-a", predicate: (state) => isUp(state.status) },
          { name: "service-b", predicate: (state) => isUp(state.status) },
        ]);

        const stateA = yield* orc.getState("service-a");
        const stateB = yield* orc.getState("service-b");

        expect(stateA.pid).toBeGreaterThan(0);
        expect(stateB.pid).toBeGreaterThan(0);
        expect(stateA.startedAt!).toBeLessThanOrEqual(stateB.startedAt!);

        yield* orc.stop;
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "health check transitions to Healthy with exec probe",
    () => {
      const flagFile = `/tmp/pc-e2e-flag-${process.pid}`;

      const defs: ServiceDef[] = [
        {
          name: "flag-service",
          command: "sh",
          args: ["-c", `touch ${flagFile} && sleep 60`],
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
          healthCheck: {
            probe: fileExistsProbe(flagFile),
            initialDelaySeconds: 0,
            periodSeconds: 0.1,
            timeoutSeconds: 2,
            successThreshold: 1,
            failureThreshold: 3,
          },
        },
      ];

      const { layer } = setupReal(defs);

      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();

        yield* waitForStatuses(orc, [
          { name: "flag-service", predicate: (state) => state.status === "Healthy" },
        ]);

        const state = yield* orc.getState("flag-service");
        expect(state.status).toBe("Healthy");
        yield* orc.stop;
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "stop() terminates all running services",
    () => {
      const defs: ServiceDef[] = [
        { name: "long-a", command: "sleep", args: ["30"] },
        { name: "long-b", command: "sleep", args: ["30"] },
      ];

      const { layer } = setupReal(defs);

      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();

        yield* waitForStatuses(orc, [
          { name: "long-a", predicate: (state) => isUp(state.status) },
          { name: "long-b", predicate: (state) => isUp(state.status) },
        ]);

        const a = yield* orc.getState("long-a");
        const b = yield* orc.getState("long-b");
        expect(a.pid).toBeGreaterThan(0);
        expect(b.pid).toBeGreaterThan(0);

        yield* orc.stop;
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "stop() shuts down independent services in parallel",
    () => {
      const defs: ServiceDef[] = [
        { name: "sleep-a", command: "sleep", args: ["60"], shutdown: { timeoutSeconds: 2 } },
        { name: "sleep-b", command: "sleep", args: ["60"], shutdown: { timeoutSeconds: 2 } },
        { name: "sleep-c", command: "sleep", args: ["60"], shutdown: { timeoutSeconds: 2 } },
      ];

      const { layer } = setupReal(defs);

      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();

        yield* waitForStatuses(orc, [
          { name: "sleep-a", predicate: (state) => isUp(state.status) },
          { name: "sleep-b", predicate: (state) => isUp(state.status) },
          { name: "sleep-c", predicate: (state) => isUp(state.status) },
        ]);

        const before = yield* Clock.currentTimeMillis;
        yield* orc.stop;
        const elapsed = (yield* Clock.currentTimeMillis) - before;

        // 3 services * 2s timeout each = 6s sequential.
        // sleep responds to SIGTERM quickly, so parallel should be < 2s.
        expect(elapsed).toBeLessThan(4000);
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "captures stdout lines in LogBuffer",
    () => {
      const defs: ServiceDef[] = [
        {
          name: "echo-svc",
          command: "sh",
          args: ["-c", "echo line-one && echo line-two && echo line-three && sleep 60"],
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
        },
      ];

      const graph = Effect.runSync(buildGraph(defs));
      const layer = Orchestrator.layer(graph).pipe(Layer.provideMerge(deps));

      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        const logBuffer = yield* LogBuffer;
        const linesReady = yield* Effect.forkChild(
          logBuffer.subscribe("echo-svc").pipe(Stream.take(3), Stream.runCollect),
          { startImmediately: true },
        );

        yield* orc.start();
        const entries = yield* Fiber.join(linesReady);
        const lines = entries.map((e) => e.line);
        expect(lines).toContain("line-one");
        expect(lines).toContain("line-two");
        expect(lines).toContain("line-three");

        yield* orc.stop;
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );
});

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("resource cleanup", () => {
  it.live(
    "stop() kills all child process PIDs",
    () => {
      const defs: ServiceDef[] = [
        {
          name: "svc-a",
          command: "sleep",
          args: ["60"],
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
        },
        {
          name: "svc-b",
          command: "sleep",
          args: ["60"],
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
        },
      ];

      const { layer } = setupReal(defs);

      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();

        yield* waitForStatuses(orc, [
          { name: "svc-a", predicate: (state) => isUp(state.status) },
          { name: "svc-b", predicate: (state) => isUp(state.status) },
        ]);

        const pidA = (yield* orc.getState("svc-a")).pid!;
        const pidB = (yield* orc.getState("svc-b")).pid!;
        expect(pidA).toBeGreaterThan(0);
        expect(pidB).toBeGreaterThan(0);
        expect(isPidAlive(pidA)).toBe(true);
        expect(isPidAlive(pidB)).toBe(true);

        yield* orc.stop;

        expect(isPidAlive(pidA)).toBe(false);
        expect(isPidAlive(pidB)).toBe(false);
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "stopService() kills only the targeted process",
    () => {
      const defs: ServiceDef[] = [
        {
          name: "target",
          command: "sleep",
          args: ["60"],
          restart: "no",
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
        },
        {
          name: "bystander",
          command: "sleep",
          args: ["60"],
          restart: "no",
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
        },
      ];

      const { layer } = setupReal(defs);

      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();

        yield* waitForStatuses(orc, [
          { name: "target", predicate: (state) => isUp(state.status) },
          { name: "bystander", predicate: (state) => isUp(state.status) },
        ]);

        const pidTarget = (yield* orc.getState("target")).pid!;
        const pidBystander = (yield* orc.getState("bystander")).pid!;

        yield* orc.stopService("target");

        expect(isPidAlive(pidTarget)).toBe(false);
        expect(isPidAlive(pidBystander)).toBe(true);

        yield* orc.stop;
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "unless-stopped service stays dead after explicit stop",
    () => {
      const defs: ServiceDef[] = [
        {
          name: "restartable",
          command: "sleep",
          args: ["60"],
          restart: "unless-stopped",
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
        },
      ];

      const { layer } = setupReal(defs);

      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();

        yield* waitForStatuses(orc, [
          { name: "restartable", predicate: (state) => isUp(state.status) },
        ]);

        const originalPid = (yield* orc.getState("restartable")).pid!;
        yield* orc.stopService("restartable");

        expect(isPidAlive(originalPid)).toBe(false);
        const state = yield* orc.getState("restartable");
        expect(state.status).toBe("Stopped");

        yield* orc.stop;
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "exec health probe processes cleaned up on stop",
    () => {
      const flagFile = `/tmp/pc-cleanup-flag-${process.pid}`;
      const defs: ServiceDef[] = [
        {
          name: "probed",
          command: "sh",
          args: ["-c", `touch ${flagFile} && sleep 60`],
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
          healthCheck: {
            probe: fileExistsProbe(flagFile),
            initialDelaySeconds: 0,
            periodSeconds: 0.2,
            timeoutSeconds: 2,
            successThreshold: 1,
            failureThreshold: 3,
          },
        },
      ];

      const { layer } = setupReal(defs);

      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();

        yield* waitForStatuses(orc, [
          { name: "probed", predicate: (state) => state.status === "Healthy" },
        ]);

        const pid = (yield* orc.getState("probed")).pid!;
        yield* orc.stop;

        expect(isPidAlive(pid)).toBe(false);
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "scope closure kills children without explicit stop",
    () => {
      const defs: ServiceDef[] = [
        {
          name: "scoped-a",
          command: "sleep",
          args: ["60"],
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
        },
        {
          name: "scoped-b",
          command: "sleep",
          args: ["60"],
          shutdown: { signal: "SIGTERM", timeoutSeconds: 1 },
        },
      ];

      const { layer } = setupReal(defs);
      let capturedPidA = 0;
      let capturedPidB = 0;

      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const orc = yield* Orchestrator;
          yield* orc.start();

          yield* waitForStatuses(orc, [
            { name: "scoped-a", predicate: (state) => isUp(state.status) },
            { name: "scoped-b", predicate: (state) => isUp(state.status) },
          ]);

          capturedPidA = (yield* orc.getState("scoped-a")).pid!;
          capturedPidB = (yield* orc.getState("scoped-b")).pid!;
          expect(capturedPidA).toBeGreaterThan(0);
          expect(capturedPidB).toBeGreaterThan(0);
        }).pipe(Effect.provide(layer), Effect.scoped);

        // Scope closure owns the child finalizers, so they complete before this assertion.
        expect(isPidAlive(capturedPidA)).toBe(false);
        expect(isPidAlive(capturedPidB)).toBe(false);
      });
    },
    { timeout: 15000 },
  );
});
