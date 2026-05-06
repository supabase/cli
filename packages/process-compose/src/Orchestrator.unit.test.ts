import { describe, expect, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { buildGraph } from "./DependencyGraph.ts";
import { LogBuffer } from "./LogBuffer.ts";
import { Orchestrator } from "./Orchestrator.ts";
import type { OrchestratorConfig, ServiceDef } from "./ServiceDef.ts";
import type { ServiceState } from "./ServiceState.ts";

// --- Mock factories ---

const encoder = new TextEncoder();

function mockLogBuffer() {
  const entries: Array<{ service: string; stream: string; line: string }> = [];
  const entryEvents = createWaitList();
  return {
    layer: Layer.succeed(LogBuffer, {
      append: (service: string, stream: "stdout" | "stderr", line: string) =>
        Effect.sync(() => {
          entries.push({ service, stream, line });
          entryEvents.notify();
        }),
      subscribe: (_service: string) => Stream.empty,
      subscribeAll: () => Stream.empty,
      history: (service: string, limit = 100) =>
        Effect.sync(() => {
          const matching = entries.filter((e) => e.service === service);
          const sliced = matching.slice(-limit);
          return sliced.map((e) => ({
            timestamp: Date.now(),
            service: e.service,
            stream: e.stream as "stdout" | "stderr",
            line: e.line,
          }));
        }),
      historyAll: (limit = 100, services?: ReadonlyArray<string>) =>
        Effect.sync(() => {
          const filtered =
            services === undefined || services.length === 0
              ? entries
              : entries.filter((entry) => services.includes(entry.service));
          const sliced = filtered.slice(-limit);
          return sliced.map((entry) => ({
            timestamp: Date.now(),
            service: entry.service,
            stream: entry.stream as "stdout" | "stderr",
            line: entry.line,
          }));
        }),
      truncate: () => Effect.void,
    }),
    get entries() {
      return entries;
    },
    waitForEntry(
      predicate: (entry: { service: string; stream: string; line: string }) => boolean,
      description: string,
    ) {
      return entryEvents.waitUntil(() => entries.some(predicate), description);
    },
  };
}

interface SpawnRecord {
  command: string;
  args: ReadonlyArray<string>;
}

interface KillRecord {
  command: string;
  signal: string;
}

interface SpawnOpts {
  exitCode?: number;
  getExitCode?: () => number;
  stdout?: string[];
  exitDelay?: Duration.Input;
}

function createWaitList() {
  interface Waiter {
    readonly ready: () => boolean;
    readonly resolve: () => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }

  const waiters = new Set<Waiter>();

  const notify = () => {
    for (const waiter of waiters) {
      if (waiter.ready()) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  const waitUntil = (ready: () => boolean, description: string, timeoutMs = 2_000) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          if (ready()) {
            resolve();
            return;
          }

          const waiter: Waiter = {
            ready,
            resolve,
            timeout: setTimeout(() => {
              waiters.delete(waiter);
              reject(new Error(`Timed out waiting for ${description}`));
            }, timeoutMs),
          };
          waiters.add(waiter);
        }),
    );

  return { notify, waitUntil };
}

const waitForState = (
  orc: Orchestrator["Service"],
  name: string,
  predicate: (state: ServiceState) => boolean,
  description: string,
) =>
  Effect.gen(function* () {
    const current = yield* orc.getState(name);
    if (predicate(current)) return current;

    const stream = yield* orc.stateChanges(name);
    const result = yield* stream.pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.timeout(Duration.seconds(3)),
    );
    return Option.getOrThrowWith(
      result,
      () => new Error(`Timed out waiting for ${name} to become ${description}`),
    );
  });

const waitForHealthy = (orc: Orchestrator["Service"], name: string) =>
  waitForState(orc, name, (state) => state.status === "Healthy", "Healthy");

const waitForFailed = (orc: Orchestrator["Service"], name: string) =>
  waitForState(orc, name, (state) => state.status === "Failed", "Failed");

const waitForStopped = (orc: Orchestrator["Service"], name: string) =>
  waitForState(orc, name, (state) => state.status === "Stopped", "Stopped");

function mockChildProcessSpawner(
  opts: SpawnOpts & {
    perService?: Record<string, SpawnOpts>;
    onSpawn?: (record: SpawnRecord) => void;
  } = {},
) {
  const spawned: SpawnRecord[] = [];
  const killed: KillRecord[] = [];
  const spawnEvents = createWaitList();
  const killEvents = createWaitList();

  return {
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const cmd = command._tag === "StandardCommand" ? command.command : "";
          const args = command._tag === "StandardCommand" ? command.args : [];
          const record: SpawnRecord = { command: cmd, args };
          spawned.push(record);
          opts.onSpawn?.(record);
          spawnEvents.notify();

          // Per-service overrides
          const svcOpts = opts.perService?.[cmd] ?? opts;
          const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();

          const resolvedExitCode = svcOpts.getExitCode?.() ?? svcOpts.exitCode ?? 0;
          yield* Effect.forkDetach(
            Effect.andThen(
              Effect.sleep(svcOpts.exitDelay ?? "10 millis"),
              Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(resolvedExitCode)),
            ),
          );

          const stdoutBytes = (svcOpts.stdout ?? []).map((line) => encoder.encode(`${line}\n`));

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1000 + spawned.length),
            stdout: Stream.fromIterable(stdoutBytes),
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Deferred.await(exitDeferred),
            isRunning: Effect.succeed(true),
            stdin: Sink.drain,
            kill: (killOpts) =>
              Effect.gen(function* () {
                killed.push({ command: cmd, signal: killOpts?.killSignal ?? "SIGTERM" });
                killEvents.notify();
                yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(143));
              }),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    get spawned() {
      return spawned;
    },
    get killed() {
      return killed;
    },
    waitForSpawnCount(count: number) {
      return spawnEvents.waitUntil(
        () => spawned.length >= count,
        `${count} spawned processes; saw ${spawned.length}`,
      );
    },
    waitForSpawn(command: string, count = 1) {
      return spawnEvents.waitUntil(
        () => spawned.filter((record) => record.command === command).length >= count,
        `${count} spawned ${command} processes`,
      );
    },
    waitForKillCount(count: number) {
      return killEvents.waitUntil(
        () => killed.length >= count,
        `${count} killed processes; saw ${killed.length}`,
      );
    },
  };
}

function setupOrchestrator(
  defs: ReadonlyArray<ServiceDef>,
  runnerOpts: Parameters<typeof mockChildProcessSpawner>[0] = {},
  config?: OrchestratorConfig,
) {
  const graph = Effect.runSync(buildGraph(defs));
  const proc = mockChildProcessSpawner(runnerOpts);
  const log = mockLogBuffer();
  const layer = Orchestrator.layer(graph, config).pipe(
    Layer.provide(Layer.mergeAll(proc.layer, log.layer)),
  );
  return { graph, proc, log, layer };
}

function mockStuckChildProcessSpawner() {
  const spawned: SpawnRecord[] = [];
  const killed: string[] = [];

  return {
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const cmd = command._tag === "StandardCommand" ? command.command : "";
          const args = command._tag === "StandardCommand" ? command.args : [];
          spawned.push({ command: cmd, args });

          // exitCode Deferred that is NEVER resolved — simulates stuck process
          const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1000 + spawned.length),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Deferred.await(exitDeferred),
            isRunning: Effect.succeed(true),
            stdin: Sink.drain,
            kill: (killOpts) =>
              Effect.gen(function* () {
                const signal = killOpts?.killSignal ?? "SIGTERM";
                killed.push(signal);
                // SIGKILL always succeeds — resolve exit deferred
                if (signal === "SIGKILL") {
                  yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(137));
                }
                // Await exit like the real spawner — blocks until process exits
                yield* Deferred.await(exitDeferred);
              }).pipe(Effect.asVoid),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    get spawned() {
      return spawned;
    },
    get killed() {
      return killed;
    },
  };
}

function setupOrchestratorWithStuckKill(
  defs: ReadonlyArray<ServiceDef>,
  config?: OrchestratorConfig,
) {
  const graph = Effect.runSync(buildGraph(defs));
  const proc = mockStuckChildProcessSpawner();
  const log = mockLogBuffer();
  const layer = Orchestrator.layer(graph, config).pipe(
    Layer.provide(Layer.mergeAll(proc.layer, log.layer)),
  );
  return { graph, proc, log, layer };
}

// --- Helpers ---

const svc = (name: string, overrides?: Partial<ServiceDef>): ServiceDef => ({
  name,
  command: name,
  ...overrides,
});

// --- Tests ---

describe("Orchestrator", () => {
  it.live("start() spawns all services", () => {
    const { layer, proc } = setupOrchestrator([svc("a"), svc("b"), svc("c")]);
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* proc.waitForSpawnCount(3);
      expect(proc.spawned.length).toBe(3);
      const names = proc.spawned.map((s) => s.command).sort();
      expect(names).toEqual(["a", "b", "c"]);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("start() respects dependency order via started condition", () => {
    const spawnOrder: string[] = [];
    const { layer } = setupOrchestrator(
      [
        svc("db"),
        svc("api", {
          dependencies: [{ service: "db", condition: "started" }],
        }),
      ],
      {
        exitDelay: "500 millis",
        onSpawn: (o) => spawnOrder.push(o.command),
      },
    );
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* waitForHealthy(orc, "api");
      expect(spawnOrder[0]).toBe("db");
      expect(spawnOrder[1]).toBe("api");
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("getState returns current state for a service", () => {
    const { layer } = setupOrchestrator([svc("a")], {
      exitDelay: "500 millis",
    });
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* waitForHealthy(orc, "a");
      const state = yield* orc.getState("a");
      // Should be Running or Healthy (no health check = immediate Healthy)
      expect(["Running", "Healthy"]).toContain(state.status);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("getState returns ServiceNotFoundError for unknown service", () => {
    const { layer } = setupOrchestrator([svc("a")]);
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      const exit = yield* orc.getState("nonexistent").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("getAllStates returns state for every service", () => {
    const { layer } = setupOrchestrator([svc("a"), svc("b")]);
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      const states = yield* orc.getAllStates();
      expect(states.length).toBe(2);
      const names = states.map((s) => s.name).sort();
      expect(names).toEqual(["a", "b"]);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("stopService sets state to Stopped", () => {
    const { layer } = setupOrchestrator([svc("a")], {
      exitDelay: "5 seconds",
    });
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* waitForHealthy(orc, "a");
      yield* orc.stopService("a");
      const state = yield* orc.getState("a");
      expect(state.status).toBe("Stopped");
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("stop() interrupts all service fibers", () => {
    const { layer, proc } = setupOrchestrator([svc("a"), svc("b")], {
      exitDelay: "5 seconds",
    });
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* proc.waitForSpawnCount(2);
      expect(proc.spawned.length).toBe(2);
      yield* orc.stop();
      yield* proc.waitForKillCount(2);
      // Kill should have been called for each service (via finalizer)
      expect(proc.killed.length).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("supervised services spawn the supervisor runtime", () => {
    const { layer, proc } = setupOrchestrator([
      svc("postgres", {
        command: "docker",
        args: ["run", "--rm", "postgres"],
        supervision: {
          orphanCleanup: [{ _tag: "DockerRemove", containerName: "supabase-postgres-test" }],
        },
      }),
    ]);
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* proc.waitForSpawnCount(1);
      expect(proc.spawned).toHaveLength(1);
      expect(proc.spawned[0]?.command).toMatch(/(^node$|node(\.exe)?$|\/node$|\\node\.exe$)/);
      expect(proc.spawned[0]?.args[0]).toContain("supervisor-runtime.mjs");
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("ServiceDef shutdown does not expose killMode", () => {
    const service: ServiceDef = {
      name: "a",
      command: "a",
      shutdown: {
        signal: "SIGTERM",
        // @ts-expect-error killMode was removed; supervision owns tree teardown.
        killMode: "group",
      },
    };

    return Effect.sync(() => {
      expect(service.shutdown?.signal).toBe("SIGTERM");
    });
  });

  it.live("stop() waits for service cleanup finalizers", () => {
    let cleanedUp = false;
    const { layer, proc } = setupOrchestrator(
      [
        svc("postgres", {
          cleanup: Effect.sleep(Duration.millis(150)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                cleanedUp = true;
              }),
            ),
          ),
        }),
      ],
      { exitDelay: "5 seconds" },
    );
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* proc.waitForSpawnCount(1);
      yield* orc.stop();
      expect(cleanedUp).toBe(true);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("startService starts transitive dependencies", () => {
    const { layer, proc } = setupOrchestrator(
      [
        svc("db"),
        svc("api", {
          dependencies: [{ service: "db", condition: "started" }],
        }),
        svc("web", {
          dependencies: [{ service: "api", condition: "started" }],
        }),
        svc("unrelated"),
      ],
      { exitDelay: "500 millis" },
    );
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.startService("web");
      yield* proc.waitForSpawnCount(3);
      const names = proc.spawned.map((s) => s.command).sort();
      // Should start db, api, web — but NOT unrelated
      expect(names).toEqual(["api", "db", "web"]);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("restartService stops and restarts a service", () => {
    const { layer, proc } = setupOrchestrator([svc("a")], {
      exitDelay: "5 seconds",
    });
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* proc.waitForSpawnCount(1);
      expect(proc.spawned.length).toBe(1);
      yield* orc.restartService("a");
      yield* proc.waitForSpawnCount(2);
      // Should have spawned twice
      expect(proc.spawned.length).toBe(2);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("stateChanges returns a stream of state transitions", () => {
    const { layer } = setupOrchestrator([svc("a")], {
      exitDelay: "200 millis",
    });
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      const stream = yield* orc.stateChanges("a");
      // Collect state changes with a timeout
      const fiber = yield* stream.pipe(
        Stream.takeUntil((s) => s.status === "Stopped"),
        Stream.runCollect,
        Effect.timeout(Duration.seconds(2)),
        Effect.forkChild,
      );
      yield* orc.start();
      const result = yield* Fiber.join(fiber);
      // result is Option<Chunk<ServiceState>> due to timeout
      // The stream should have collected at least Pending, Starting, etc.
      expect(result).toBeDefined();
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("disabled services are not started", () => {
    const { layer, proc } = setupOrchestrator([svc("a"), svc("b", { enabled: false })]);
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* proc.waitForSpawnCount(1);
      const names = proc.spawned.map((s) => s.command);
      expect(names).toEqual(["a"]);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("services without health check are marked Healthy immediately", () => {
    const { layer } = setupOrchestrator([svc("a")], {
      exitDelay: "500 millis",
    });
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* waitForHealthy(orc, "a");
      const state = yield* orc.getState("a");
      expect(state.status).toBe("Healthy");
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("logs are captured via LogBuffer", () => {
    const { layer, log } = setupOrchestrator([svc("a")], {
      stdout: ["hello world"],
      exitDelay: "200 millis",
    });
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* log.waitForEntry(
        (entry) => entry.service === "a" && entry.line === "hello world",
        "service stdout log",
      );
      const matching = log.entries.filter((e) => e.service === "a" && e.line === "hello world");
      expect(matching.length).toBe(1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("process exit with code 0 sets Stopped", () => {
    const { layer } = setupOrchestrator([svc("a", { restart: "no" })], {
      exitCode: 0,
      exitDelay: "50 millis",
    });
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* waitForStopped(orc, "a");
      const state = yield* orc.getState("a");
      expect(state.status).toBe("Stopped");
      expect(state.exitCode).toBe(0);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.live("process exit with non-zero code sets Failed", () => {
    const { layer } = setupOrchestrator([svc("a", { restart: "no" })], {
      exitCode: 1,
      exitDelay: "50 millis",
    });
    return Effect.gen(function* () {
      const orc = yield* Orchestrator;
      yield* orc.start();
      yield* waitForFailed(orc, "a");
      const state = yield* orc.getState("a");
      expect(state.status).toBe("Failed");
      expect(state.exitCode).toBe(1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  describe("dependency timeout", () => {
    it.live("transitions to Failed when dependency never becomes healthy", () => {
      const { layer } = setupOrchestrator(
        [
          svc("db", {
            restart: "no",
            healthCheck: {
              probe: { _tag: "Exec", command: "true", args: [] },
              initialDelaySeconds: 999,
            },
          }),
          svc("api", {
            restart: "no",
            dependencies: [{ service: "db", condition: "healthy" }],
            dependencyTimeoutSeconds: 0.2,
          }),
        ],
        { exitDelay: "5 seconds" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForFailed(orc, "api");
        const state = yield* orc.getState("api");
        expect(state.status).toBe("Failed");
        expect(state.error).toContain("Timed out");
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("no timeout when dependency resolves before deadline", () => {
      const { layer } = setupOrchestrator(
        [
          svc("db"),
          svc("api", {
            dependencies: [{ service: "db", condition: "started" }],
            dependencyTimeoutSeconds: 5,
          }),
        ],
        { exitDelay: "500 millis" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForState(
          orc,
          "api",
          (state) => state.status === "Running" || state.status === "Healthy",
          "Running or Healthy",
        );
        const state = yield* orc.getState("api");
        expect(["Running", "Healthy"]).toContain(state.status);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("timeout with completed condition", () => {
      const { layer } = setupOrchestrator(
        [
          svc("setup", { restart: "no" }),
          svc("app", {
            restart: "no",
            dependencies: [{ service: "setup", condition: "completed" }],
            dependencyTimeoutSeconds: 0.1,
          }),
        ],
        {
          exitDelay: "5 seconds",
        },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForFailed(orc, "app");
        const state = yield* orc.getState("app");
        expect(state.status).toBe("Failed");
        expect(state.error).toContain("Timed out");
      }).pipe(Effect.provide(layer), Effect.scoped);
    });
  });

  describe("failure diagnostics", () => {
    it.live("logs diagnostic output when service becomes unhealthy", () => {
      let checkCalls = 0;
      const { layer, log } = setupOrchestrator(
        [
          svc("a", {
            restart: "no",
            healthCheck: {
              probe: { _tag: "Exec", command: "check", args: [] },
              periodSeconds: 0.05,
              successThreshold: 1,
              failureThreshold: 2,
            },
          }),
        ],
        {
          exitDelay: "5 seconds",
          stdout: ["line1", "line2", "error: something broke"],
          perService: {
            check: {
              exitDelay: "1 millis",
              getExitCode: () => {
                checkCalls++;
                return checkCalls <= 1 ? 0 : 1;
              },
            },
          },
        },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* log.waitForEntry(
          (entry) => entry.service === "a" && entry.line.includes("[health-check-failed]"),
          "health-check failure diagnostic",
        );
        const diagnosticEntries = log.entries.filter(
          (e) => e.service === "a" && e.line.includes("[health-check-failed]"),
        );
        expect(diagnosticEntries.length).toBeGreaterThanOrEqual(1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });
  });

  describe("lifecycle hooks", () => {
    it.live("runs on:started hook after process spawns", () => {
      let hookRan = false;
      const { layer } = setupOrchestrator(
        [
          svc("a", {
            hooks: [
              {
                on: "started",
                run: (_log) =>
                  Effect.sync(() => {
                    hookRan = true;
                  }),
              },
            ],
          }),
        ],
        { exitDelay: "500 millis" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForHealthy(orc, "a");
        expect(hookRan).toBe(true);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("runs on:healthy hook after health check passes", () => {
      let hookRan = false;
      const { layer } = setupOrchestrator(
        [
          svc("a", {
            hooks: [
              {
                on: "healthy",
                run: (_log) =>
                  Effect.sync(() => {
                    hookRan = true;
                  }),
              },
            ],
          }),
        ],
        { exitDelay: "500 millis" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForHealthy(orc, "a");
        expect(hookRan).toBe(true);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("dependent waits for on:healthy hook to complete before starting", () => {
      const order: string[] = [];
      const { layer } = setupOrchestrator(
        [
          svc("db", {
            hooks: [
              {
                on: "healthy",
                run: (_log) =>
                  Effect.gen(function* () {
                    yield* Effect.sleep(Duration.millis(100));
                    order.push("db-hook-done");
                  }),
              },
            ],
          }),
          svc("api", {
            dependencies: [{ service: "db", condition: "healthy" }],
          }),
        ],
        {
          exitDelay: "5 seconds",
          onSpawn: (r) => {
            if (r.command === "api") order.push("api-spawned");
          },
        },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForHealthy(orc, "api");
        expect(order).toEqual(["db-hook-done", "api-spawned"]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("hook failure with policy:fail transitions to Failed", () => {
      const { layer } = setupOrchestrator(
        [
          svc("a", {
            restart: "no",
            hooks: [
              {
                on: "started",
                run: (_log) => Effect.fail(new Error("migration failed")),
              },
            ],
          }),
        ],
        { exitDelay: "5 seconds" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForFailed(orc, "a");
        const state = yield* orc.getState("a");
        expect(state.status).toBe("Failed");
        expect(state.error).toContain("migration failed");
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("hook failure with policy:ignore continues normally", () => {
      const { layer } = setupOrchestrator(
        [
          svc("a", {
            hooks: [
              {
                on: "started",
                run: (_log) => Effect.fail(new Error("optional hook failed")),
                failurePolicy: "ignore",
              },
            ],
          }),
        ],
        { exitDelay: "500 millis" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForHealthy(orc, "a");
        const state = yield* orc.getState("a");
        expect(state.status).toBe("Healthy");
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("hook timeout transitions to Failed", () => {
      const { layer } = setupOrchestrator(
        [
          svc("a", {
            restart: "no",
            hooks: [
              {
                on: "started",
                run: (_log) => Effect.sleep(Duration.seconds(60)),
                timeoutSeconds: 0.1,
              },
            ],
          }),
        ],
        { exitDelay: "5 seconds" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForFailed(orc, "a");
        const state = yield* orc.getState("a");
        expect(state.status).toBe("Failed");
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("hooks re-run on service restart", () => {
      let hookCount = 0;
      const { layer } = setupOrchestrator(
        [
          svc("a", {
            hooks: [
              {
                on: "started",
                run: (_log) =>
                  Effect.sync(() => {
                    hookCount++;
                  }),
              },
            ],
          }),
        ],
        { exitDelay: "5 seconds" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForHealthy(orc, "a");
        expect(hookCount).toBe(1);
        yield* orc.restartService("a");
        yield* waitForHealthy(orc, "a");
        expect(hookCount).toBe(2);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("multiple hooks on same trigger run in order", () => {
      const order: number[] = [];
      const { layer } = setupOrchestrator(
        [
          svc("a", {
            hooks: [
              { on: "started", run: (_log) => Effect.sync(() => order.push(1)) },
              { on: "started", run: (_log) => Effect.sync(() => order.push(2)) },
              { on: "started", run: (_log) => Effect.sync(() => order.push(3)) },
            ],
          }),
        ],
        { exitDelay: "500 millis" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForHealthy(orc, "a");
        expect(order).toEqual([1, 2, 3]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("hook can log to service log buffer via log callback", () => {
      const { layer, log } = setupOrchestrator(
        [
          svc("a", {
            hooks: [
              {
                on: "started",
                run: (log) =>
                  Effect.gen(function* () {
                    yield* log("stdout", "migration starting");
                    yield* log("stdout", "migration complete");
                  }),
              },
            ],
          }),
        ],
        { exitDelay: "500 millis" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* log.waitForEntry(
          (entry) => entry.service === "a" && entry.line === "migration complete",
          "hook completion log",
        );
        const hookLogs = log.entries.filter(
          (e) => e.service === "a" && e.line === "migration complete",
        );
        expect(hookLogs.length).toBe(1);
        expect(hookLogs[0]?.stream).toBe("stdout");
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("hook log callback is scoped to the correct service", () => {
      const { layer, log } = setupOrchestrator(
        [
          svc("db", {
            hooks: [{ on: "started", run: (log) => log("stdout", "db-hook-log") }],
          }),
          svc("api", {
            dependencies: [{ service: "db", condition: "started" }],
            hooks: [{ on: "started", run: (log) => log("stdout", "api-hook-log") }],
          }),
        ],
        { exitDelay: "500 millis" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForHealthy(orc, "api");
        const dbLogs = log.entries.filter((e) => e.service === "db" && e.line === "db-hook-log");
        const apiLogs = log.entries.filter((e) => e.service === "api" && e.line === "api-hook-log");
        expect(dbLogs.length).toBe(1);
        expect(apiLogs.length).toBe(1);
        // No cross-contamination
        const cross = log.entries.filter((e) => e.service === "db" && e.line === "api-hook-log");
        expect(cross.length).toBe(0);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("failed hook with ignore policy still captures log output", () => {
      const { layer, log } = setupOrchestrator(
        [
          svc("a", {
            hooks: [
              {
                on: "started",
                run: (log) =>
                  Effect.gen(function* () {
                    yield* log("stderr", "attempting migration...");
                    yield* Effect.fail(new Error("migration failed"));
                  }),
                failurePolicy: "ignore",
              },
            ],
          }),
        ],
        { exitDelay: "500 millis" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForHealthy(orc, "a");
        const state = yield* orc.getState("a");
        expect(state.status).toBe("Healthy");
        const hookLogs = log.entries.filter(
          (e) => e.service === "a" && e.line === "attempting migration...",
        );
        expect(hookLogs.length).toBe(1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });
  });

  describe("parallel shutdown", () => {
    it.live("stop() stops all independent services", () => {
      const { layer, proc } = setupOrchestrator([svc("a"), svc("b"), svc("c")], {
        exitDelay: "5 seconds",
      });
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* proc.waitForSpawnCount(3);
        yield* orc.stop();
        const states = yield* orc.getAllStates();
        for (const s of states) {
          expect(s.status).toBe("Stopped");
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("stop() respects dependency order: dependent stops before dependency", () => {
      const { layer, proc } = setupOrchestrator(
        [
          svc("db"),
          svc("api", {
            dependencies: [{ service: "db", condition: "started" }],
          }),
        ],
        { exitDelay: "5 seconds" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* proc.waitForSpawn("api");
        yield* orc.stop();

        // api must stop before db (dependent before dependency)
        const killOrder = proc.killed.map((record) => record.command);
        expect(killOrder.indexOf("api")).toBeLessThan(killOrder.indexOf("db"));
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("stop() handles diamond dependencies", () => {
      const { layer, proc } = setupOrchestrator(
        [
          svc("a"),
          svc("b", { dependencies: [{ service: "a", condition: "started" }] }),
          svc("c", { dependencies: [{ service: "a", condition: "started" }] }),
          svc("d", {
            dependencies: [
              { service: "b", condition: "started" },
              { service: "c", condition: "started" },
            ],
          }),
        ],
        { exitDelay: "5 seconds" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* proc.waitForSpawnCount(4);
        yield* orc.stop();
        const states = yield* orc.getAllStates();
        for (const s of states) {
          expect(s.status).toBe("Stopped");
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    });
  });

  describe("global shutdown timeout", () => {
    it.live("stop() completes within timeout under normal conditions", () => {
      const { layer } = setupOrchestrator(
        [svc("a"), svc("b")],
        { exitDelay: "5 seconds" },
        { shutdownTimeoutSeconds: 5 },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForHealthy(orc, "a");
        yield* orc.stop();
        const states = yield* orc.getAllStates();
        for (const s of states) {
          expect(s.status).toBe("Stopped");
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("stop() force-interrupts when global timeout expires", () => {
      const { layer } = setupOrchestratorWithStuckKill(
        [svc("stuck", { shutdown: { timeoutSeconds: 999 } })],
        { shutdownTimeoutSeconds: 0.5 },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForState(orc, "stuck", (state) => state.status === "Healthy", "Healthy");
        const before = Date.now();
        yield* orc.stop();
        const elapsed = Date.now() - before;
        expect(elapsed).toBeLessThan(3000);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("stop() logs warning when global timeout fires", () => {
      const { layer, log } = setupOrchestratorWithStuckKill(
        [svc("stuck", { shutdown: { timeoutSeconds: 999 } })],
        { shutdownTimeoutSeconds: 0.3 },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForState(orc, "stuck", (state) => state.status === "Healthy", "Healthy");
        yield* orc.stop();
        const timeoutEntries = log.entries.filter((e) => e.line.includes("[shutdown-timeout]"));
        expect(timeoutEntries.length).toBeGreaterThanOrEqual(1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });
  });

  describe("unhealthy restart", () => {
    it.live("restarts service when it becomes unhealthy and restart policy allows", () => {
      let checkCalls = 0;
      const { layer, proc } = setupOrchestrator(
        [
          svc("a", {
            restart: "always",
            maxRestarts: 1,
            healthCheck: {
              probe: { _tag: "Exec", command: "check", args: [] },
              periodSeconds: 0.05,
              successThreshold: 1,
              failureThreshold: 2,
            },
          }),
        ],
        {
          exitDelay: "5 seconds",
          perService: {
            check: {
              exitDelay: "1 millis",
              getExitCode: () => {
                checkCalls++;
                // First call succeeds (→ Healthy), rest fail (→ Unhealthy)
                return checkCalls <= 1 ? 0 : 1;
              },
            },
          },
        },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* proc.waitForSpawn("a", 2);
        // Should have spawned the main service twice (original + 1 restart)
        const mainSpawns = proc.spawned.filter((s) => s.command === "a");
        expect(mainSpawns.length).toBe(2);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("does not restart unhealthy service when restart policy is no", () => {
      let checkCalls = 0;
      const { layer, proc } = setupOrchestrator(
        [
          svc("a", {
            restart: "no",
            healthCheck: {
              probe: { _tag: "Exec", command: "check", args: [] },
              periodSeconds: 0.05,
              successThreshold: 1,
              failureThreshold: 2,
            },
          }),
        ],
        {
          exitDelay: "5 seconds",
          perService: {
            check: {
              exitDelay: "1 millis",
              getExitCode: () => {
                checkCalls++;
                return checkCalls <= 1 ? 0 : 1;
              },
            },
          },
        },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* waitForState(orc, "a", (state) => state.status === "Unhealthy", "Unhealthy");
        const state = yield* orc.getState("a");
        expect(state.status).toBe("Unhealthy");
        const mainSpawns = proc.spawned.filter((s) => s.command === "a");
        expect(mainSpawns.length).toBe(1);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("unhealthy restart respects maxRestarts", () => {
      let checkCalls = 0;
      const { layer, proc } = setupOrchestrator(
        [
          svc("a", {
            restart: "always",
            maxRestarts: 1,
            healthCheck: {
              probe: { _tag: "Exec", command: "check", args: [] },
              periodSeconds: 0.05,
              successThreshold: 1,
              failureThreshold: 2,
            },
          }),
        ],
        {
          exitDelay: "5 seconds",
          perService: {
            check: {
              exitDelay: "1 millis",
              // Each cycle: 1 success (→ Healthy) then 2 failures (→ Unhealthy)
              getExitCode: () => (++checkCalls % 3 === 1 ? 0 : 1),
            },
          },
        },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* proc.waitForSpawn("a", 2);
        yield* waitForState(orc, "a", (state) => state.status === "Unhealthy", "Unhealthy");
        // maxRestarts=1 means original spawn + 1 restart = 2 total
        const mainSpawns = proc.spawned.filter((s) => s.command === "a");
        expect(mainSpawns.length).toBe(2);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });
  });

  describe("readiness", () => {
    it.live("waitReady resolves when long-running service becomes healthy", () => {
      const { layer } = setupOrchestrator([svc("a")], {
        exitDelay: "500 millis",
      });
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* orc.waitReady("a");
        const state = yield* orc.getState("a");
        expect(state.status).toBe("Healthy");
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("waitReady resolves when one-shot service completes successfully", () => {
      const { layer } = setupOrchestrator([svc("a", { restart: "no" })], {
        exitCode: 0,
        exitDelay: "50 millis",
      });
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* orc.waitReady("a");
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("waitReady fails when one-shot exits with non-zero code", () => {
      const { layer } = setupOrchestrator([svc("a", { restart: "no" })], {
        exitCode: 1,
        exitDelay: "50 millis",
      });
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        const exit = yield* orc.waitReady("a").pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("waitReady fails fast when service enters Failed state", () => {
      const { layer } = setupOrchestrator(
        [
          svc("a", {
            restart: "no",
            hooks: [
              {
                on: "started",
                run: (_log) => Effect.fail(new Error("startup failed")),
              },
            ],
          }),
        ],
        { exitDelay: "5 seconds" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        const exit = yield* orc.waitReady("a").pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("waitAllReady resolves when all services ready", () => {
      const { layer } = setupOrchestrator(
        [
          svc("db"),
          svc("api", {
            dependencies: [{ service: "db", condition: "started" }],
          }),
        ],
        { exitDelay: "500 millis" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        yield* orc.waitAllReady();
        const states = yield* orc.getAllStates();
        for (const s of states) {
          expect(s.status).toBe("Healthy");
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("waitAllReady fails fast if any service fails", () => {
      const { layer } = setupOrchestrator(
        [
          svc("db"),
          svc("api", {
            restart: "no",
            hooks: [
              {
                on: "started",
                run: (_log) => Effect.fail(new Error("crash")),
              },
            ],
          }),
        ],
        { exitDelay: "5 seconds" },
      );
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        yield* orc.start();
        const exit = yield* orc.waitAllReady().pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.live("waitReady returns ServiceNotFoundError for unknown service", () => {
      const { layer } = setupOrchestrator([svc("a")]);
      return Effect.gen(function* () {
        const orc = yield* Orchestrator;
        const exit = yield* orc.waitReady("nonexistent").pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(layer), Effect.scoped);
    });
  });
});
