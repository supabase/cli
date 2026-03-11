import { describe, expect, it } from "@effect/vitest";
import { layer as BunChildProcessSpawnerLayer } from "@effect/platform-bun/BunChildProcessSpawner";
import { layer as BunFileSystemLayer } from "@effect/platform-bun/BunFileSystem";
import { layer as BunPathLayer } from "@effect/platform-bun/BunPath";
import { Duration, Effect, Layer } from "effect";
import { buildGraph } from "./DependencyGraph.ts";
import { LogBuffer } from "./LogBuffer.ts";
import { Orchestrator } from "./Orchestrator.ts";
import type { ProbeConfig, ServiceDef } from "./ServiceDef.ts";

const spawnerLayer = BunChildProcessSpawnerLayer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystemLayer, BunPathLayer)),
);

const deps = Layer.mergeAll(spawnerLayer, LogBuffer.layer);

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

/** Simple poll: check condition every intervalMs, give up after maxMs */
const poll = <E>(
  check: Effect.Effect<boolean, E>,
  intervalMs = 50,
  maxMs = 5000,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const ok = yield* check;
      if (ok) return;
      yield* Effect.sleep(Duration.millis(intervalMs));
    }
  });

describe("Orchestrator E2E", () => {
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

        yield* poll(
          Effect.gen(function* () {
            const a = yield* orc.getState("service-a");
            const b = yield* orc.getState("service-b");
            return isUp(a.status) && isUp(b.status);
          }),
        );

        const stateA = yield* orc.getState("service-a");
        const stateB = yield* orc.getState("service-b");

        expect(stateA.pid).toBeGreaterThan(0);
        expect(stateB.pid).toBeGreaterThan(0);
        expect(stateA.startedAt!).toBeLessThanOrEqual(stateB.startedAt!);

        yield* orc.stop();
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "health check transitions to Healthy with exec probe",
    () => {
      const flagFile = `/tmp/pc-e2e-flag-${Date.now()}`;

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

        yield* poll(
          Effect.gen(function* () {
            const state = yield* orc.getState("flag-service");
            return state.status === "Healthy";
          }),
        );

        const state = yield* orc.getState("flag-service");
        expect(state.status).toBe("Healthy");
        yield* orc.stop();
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

        yield* poll(
          Effect.gen(function* () {
            const a = yield* orc.getState("long-a");
            const b = yield* orc.getState("long-b");
            return isUp(a.status) && isUp(b.status);
          }),
        );

        const a = yield* orc.getState("long-a");
        const b = yield* orc.getState("long-b");
        expect(a.pid).toBeGreaterThan(0);
        expect(b.pid).toBeGreaterThan(0);

        yield* orc.stop();
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

        yield* poll(
          Effect.gen(function* () {
            const states = yield* orc.getAllStates();
            return states.every((s) => isUp(s.status));
          }),
        );

        const before = Date.now();
        yield* orc.stop();
        const elapsed = Date.now() - before;

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

        yield* orc.start();

        yield* poll(
          Effect.gen(function* () {
            const entries = yield* logBuffer.history("echo-svc", 10);
            return entries.length >= 3;
          }),
        );

        const entries = yield* logBuffer.history("echo-svc", 10);
        const lines = entries.map((e) => e.line);
        expect(lines).toContain("line-one");
        expect(lines).toContain("line-two");
        expect(lines).toContain("line-three");

        yield* orc.stop();
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

        yield* poll(
          Effect.gen(function* () {
            const a = yield* orc.getState("svc-a");
            const b = yield* orc.getState("svc-b");
            return isUp(a.status) && isUp(b.status);
          }),
        );

        const pidA = (yield* orc.getState("svc-a")).pid!;
        const pidB = (yield* orc.getState("svc-b")).pid!;
        expect(pidA).toBeGreaterThan(0);
        expect(pidB).toBeGreaterThan(0);
        expect(isPidAlive(pidA)).toBe(true);
        expect(isPidAlive(pidB)).toBe(true);

        yield* orc.stop();

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

        yield* poll(
          Effect.gen(function* () {
            const a = yield* orc.getState("target");
            const b = yield* orc.getState("bystander");
            return isUp(a.status) && isUp(b.status);
          }),
        );

        const pidTarget = (yield* orc.getState("target")).pid!;
        const pidBystander = (yield* orc.getState("bystander")).pid!;

        yield* orc.stopService("target");

        expect(isPidAlive(pidTarget)).toBe(false);
        expect(isPidAlive(pidBystander)).toBe(true);

        yield* orc.stop();
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

        yield* poll(
          Effect.gen(function* () {
            const s = yield* orc.getState("restartable");
            return isUp(s.status);
          }),
        );

        const originalPid = (yield* orc.getState("restartable")).pid!;
        yield* orc.stopService("restartable");

        // Wait long enough for a restart cycle to prove it doesn't restart
        yield* Effect.sleep(Duration.seconds(1));

        expect(isPidAlive(originalPid)).toBe(false);
        const state = yield* orc.getState("restartable");
        expect(state.status).toBe("Stopped");

        yield* orc.stop();
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
    { timeout: 15000 },
  );

  it.live(
    "exec health probe processes cleaned up on stop",
    () => {
      const flagFile = `/tmp/pc-cleanup-flag-${Date.now()}`;
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

        yield* poll(
          Effect.gen(function* () {
            const s = yield* orc.getState("probed");
            return s.status === "Healthy";
          }),
        );

        const pid = (yield* orc.getState("probed")).pid!;
        yield* orc.stop();

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

          yield* poll(
            Effect.gen(function* () {
              const a = yield* orc.getState("scoped-a");
              const b = yield* orc.getState("scoped-b");
              return isUp(a.status) && isUp(b.status);
            }),
          );

          capturedPidA = (yield* orc.getState("scoped-a")).pid!;
          capturedPidB = (yield* orc.getState("scoped-b")).pid!;
          expect(capturedPidA).toBeGreaterThan(0);
          expect(capturedPidB).toBeGreaterThan(0);
        }).pipe(Effect.provide(layer), Effect.scoped);

        // After scope closed, PIDs should be dead
        yield* Effect.sleep(Duration.millis(100));
        expect(isPidAlive(capturedPidA)).toBe(false);
        expect(isPidAlive(capturedPidB)).toBe(false);
      });
    },
    { timeout: 15000 },
  );
});
