import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Duration, Effect, Exit, Fiber, Layer } from "effect";
import { mockChildProcessSpawner } from "../../process-compose/tests/helpers/mocks.ts";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { defaultPublishableKey, defaultSecretKey, generateJwt } from "./JwtGenerator.ts";
import { StackBuildError } from "./errors.ts";
import { readPreloadLibraries } from "./pgconf.ts";
import type { AllocatedPorts } from "./PortAllocator.ts";
import { Stack } from "./Stack.ts";
import { StackLifecycleCoordinator } from "./StackLifecycleCoordinator.ts";
import { StackMetadataPersistence } from "./StackMetadataPersistence.ts";
import { StackPreparation } from "./StackPreparation.ts";
import { StackBuilder } from "./StackBuilder.ts";
import type { ResolvedStackConfig } from "./StackBuilder.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const testJwtSecret = "super-secret-jwt-token-with-at-least-32-characters-long";

/**
 * The coordinator's projected status is fed by an async stream, so it lags the
 * orchestrator's internal readiness signal that waitReady/waitAllReady resolve on —
 * on slow machines it can transiently read "Starting" (still catching up) or even
 * "Restarting" (a flaky health probe briefly failed). Only its EVENTUAL value is
 * contractual, so poll until it settles instead of asserting a snapshot.
 */
const waitForReadyStatus = <E, R>(getState: Effect.Effect<{ readonly status: string }, E, R>) =>
  Effect.gen(function* () {
    for (;;) {
      const state = yield* getState;
      if (state.status === "Running" || state.status === "Healthy") return;
      yield* Effect.sleep(Duration.millis(25));
    }
  }).pipe(Effect.timeout(Duration.seconds(5)));

const defaultPorts: AllocatedPorts = {
  apiPort: 54321,
  dbPort: 54322,
  authPort: 9999,
  postgrestPort: 54323,
  postgrestAdminPort: 54324,
  edgeRuntimePort: 54325,
  edgeRuntimeInspectorPort: 54326,
  realtimePort: 54330,
  storagePort: 54331,
  imgproxyPort: 54332,
  mailpitPort: 54333,
  mailpitSmtpPort: 54334,
  mailpitPop3Port: 54335,
  pgmetaPort: 54336,
  studioPort: 54337,
  analyticsPort: 54338,
  poolerPort: 54339,
  poolerApiPort: 54340,
};

function makeConfig(dataDir: string): ResolvedStackConfig {
  return {
    cacheRoot: "/tmp/supabase-cache",
    stackRoot: "/tmp/supabase-stack",
    runtimeRoot: "/tmp/supabase-runtime",
    projectDir: "/tmp/supabase-project",
    mode: "native",
    jwtSecret: testJwtSecret,
    lazyServices: false,
    ports: defaultPorts,
    apiPort: 54321,
    dbPort: 54322,
    publishableKey: defaultPublishableKey,
    secretKey: defaultSecretKey,
    functions: false,
    autoManagedPaths: [],
    anonJwt: generateJwt(testJwtSecret, "anon"),
    serviceRoleJwt: generateJwt(testJwtSecret, "service_role"),
    postgres: {
      port: 54322,
      dataDir,
      version: DEFAULT_VERSIONS.postgres,
      password: "postgres",
      autoExposeNewTables: true,
    },
    // postgrest/auth are disabled: their health checks are real HTTP probes
    // (unlike postgres's Exec-based pg_isready probe, which the mocked
    // ChildProcessSpawner satisfies), so nothing in this mock setup would ever
    // answer them and waitAllReady would hang/fail. Keeping only postgres
    // enabled is sufficient to exercise the enableExtension race.
    postgrest: false,
    auth: false,
    edgeRuntime: false,
    realtime: false,
    storage: false,
    imgproxy: false,
    mailpit: false,
    pgmeta: false,
    studio: false,
    analytics: false,
    vector: false,
    pooler: false,
  };
}

function setupLayer(config: ResolvedStackConfig) {
  const resolver = mockBinaryResolver();
  const spawner = mockChildProcessSpawner();
  const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(resolver.layer));
  const coordinatorLayer = StackLifecycleCoordinator.layer(config).pipe(
    Layer.provide(StackBuilder.layer),
    Layer.provide(stackPreparationLayer),
    Layer.provide(StackMetadataPersistence.noop),
  );

  const layer = Stack.layer(config).pipe(
    Layer.provide(coordinatorLayer),
    Layer.provide(spawner.layer),
    Layer.provide(NodeServices.layer),
  );

  return { layer, spawner };
}

function makeLazyConfig(dataDir: string, postgrestPort: number): ResolvedStackConfig {
  return {
    ...makeConfig(dataDir),
    lazyServices: true,
    // postgrest's health check is a real HTTP probe against 127.0.0.1:postgrestPort; the test
    // below binds a fake listener there so waitReady can actually resolve once startService
    // spawns it (spawning itself is satisfied generically by the mocked ChildProcessSpawner).
    postgrest: {
      port: postgrestPort,
      adminPort: defaultPorts.postgrestAdminPort,
      schemas: ["public"],
      extraSearchPath: ["public"],
      maxRows: 1000,
      version: DEFAULT_VERSIONS.postgrest,
    },
  };
}

function makeSlowStartConfig(dataDir: string): ResolvedStackConfig {
  return {
    ...makeConfig(dataDir),
    postgrest: {
      port: defaultPorts.postgrestPort,
      adminPort: defaultPorts.postgrestAdminPort,
      schemas: ["public"],
      extraSearchPath: ["public"],
      maxRows: 1000,
      version: DEFAULT_VERSIONS.postgrest,
    },
  };
}

interface FakeHealthyServer {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

function startFakeHealthyServer(): Promise<FakeHealthyServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("OK");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({
        port: addr.port,
        stop: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    server.on("error", reject);
  });
}

describe("StackLifecycleCoordinator enableExtension", () => {
  // Regression test: two concurrent enableExtension calls used to race on
  // pod.conf — both read the same preload list, both wrote independently, and
  // the second write clobbered the first, silently dropping one extension
  // from shared_preload_libraries. Racing the two restarts of "postgres" also
  // deadlocks the orchestrator (concurrent FiberMap.run + stopForRestart calls
  // on the same service name step on each other), so without the fix this
  // test times out rather than merely asserting the wrong libraries.
  // enableExtension is now serialized per coordinator instance with an Effect
  // Semaphore, which fixes both the lost write and the restart deadlock.
  //
  // it.live is required (not it.effect/TestClock): the mock ChildProcessSpawner
  // resolves exit codes and the postgres health-check probe via a real
  // `Effect.sleep("10 millis")`, which needs the real clock to progress.
  it.live("serializes concurrent enableExtension calls so no write is lost", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stack-lifecycle-coordinator-test-"));
    writeFileSync(join(dataDir, "postgresql.conf"), "# stock conf\n");
    const config = makeConfig(dataDir);
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start();

      yield* Effect.all([stack.enableExtension("pg_cron"), stack.enableExtension("pg_net")], {
        concurrency: "unbounded",
      });

      const libraries = yield* Effect.promise(() => readPreloadLibraries(dataDir));
      expect(libraries).toContain("pg_cron");
      expect(libraries).toContain("pg_net");
      expect(libraries).toHaveLength(2);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });

  it.live("records preload libraries without restarting postgres while stopped", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stack-lifecycle-coordinator-stopped-test-"));
    writeFileSync(join(dataDir, "postgresql.conf"), "# stock conf\n");
    const config = makeConfig(dataDir);
    const { layer, spawner } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start();
      yield* stack.stop();
      const spawnedBefore = spawner.spawned.length;

      yield* stack.enableExtension("pg_cron");

      expect(spawner.spawned).toHaveLength(spawnedBefore);
      expect((yield* stack.getState("postgres")).status).toBe("Stopped");
      expect(yield* Effect.promise(() => readPreloadLibraries(dataDir))).toEqual(["pg_cron"]);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects preload changes while the stack is still starting", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stack-lifecycle-coordinator-starting-test-"));
    writeFileSync(join(dataDir, "postgresql.conf"), "# stock conf\n");
    const config = makeSlowStartConfig(dataDir);
    const { layer, spawner } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const startFiber = yield* stack.start().pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.gen(function* () {
        for (;;) {
          if (spawner.spawned.length > 0) break;
          yield* Effect.sleep(Duration.millis(10));
        }

        const exit = yield* stack.enableExtension("pg_cron").pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* Effect.promise(() => readPreloadLibraries(dataDir))).toEqual([]);
      }).pipe(Effect.ensuring(Fiber.interrupt(startFiber)));
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });

  it.live("returns to stopped phase after start fails", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stack-lifecycle-coordinator-failed-start-test-"));
    writeFileSync(join(dataDir, "postgresql.conf"), "# stock conf\n");
    const config = makeConfig(dataDir);
    const resolver = mockBinaryResolver();
    const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(resolver.layer));
    const failingBuilderLayer = Layer.succeed(StackBuilder, {
      build: () => Effect.fail(new StackBuildError({ detail: "build failed" })),
    });
    const layer = StackLifecycleCoordinator.layer(config).pipe(
      Layer.provide(failingBuilderLayer),
      Layer.provide(stackPreparationLayer),
      Layer.provide(StackMetadataPersistence.noop),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const coordinator = yield* StackLifecycleCoordinator;
      const startExit = yield* coordinator.start().pipe(Effect.exit);

      expect(Exit.isFailure(startExit)).toBe(true);
      yield* coordinator.enableExtension("pg_cron");
      expect(yield* Effect.promise(() => readPreloadLibraries(dataDir))).toEqual(["pg_cron"]);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });
});

describe("StackLifecycleCoordinator lazyServices", () => {
  // it.live: the mocked ChildProcessSpawner and postgres's health-check probe both resolve via a
  // real `Effect.sleep`, which needs the real clock to progress (same reason as the
  // enableExtension test above).
  it.live("start() only eager-starts postgres/postgres-init; postgrest starts on demand", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stack-lifecycle-coordinator-lazy-test-"));

    return Effect.promise(() => startFakeHealthyServer()).pipe(
      Effect.flatMap((fakeServer) => {
        const config = makeLazyConfig(dataDir, fakeServer.port);
        const { layer, spawner } = setupLayer(config);

        const isPostgrestPayload = (s: { args: ReadonlyArray<string> }) => {
          const encoded = s.args.at(-1);
          if (encoded === undefined) return false;
          try {
            const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
              command?: string;
            };
            return decoded.command?.endsWith("/postgrest") ?? false;
          } catch {
            return false;
          }
        };

        return Effect.gen(function* () {
          const stack = yield* Stack;
          yield* stack.start();

          // postgrest must not have been spawned by start() itself.
          expect(spawner.spawned.some(isPostgrestPayload)).toBe(false);

          const postgrestState = yield* stack.getState("postgrest");
          expect(postgrestState.status).toBe("Pending");

          // The ApiProxy's ensureService would call startService + waitReady on first request;
          // simulate that here directly against the coordinator.
          yield* stack.startService("postgrest");
          yield* stack.waitReady("postgrest");

          expect(spawner.spawned.some(isPostgrestPayload)).toBe(true);
          // waitReady already proved the service reached a ready state — that's the actual
          // assertion above. The projected status only settles eventually; see helper doc.
          yield* waitForReadyStatus(stack.getState("postgrest"));

          yield* Effect.promise(() => fakeServer.stop());
        }).pipe(Effect.provide(layer));
      }),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects on-demand service starts before start()", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stack-lifecycle-coordinator-lazy-idle-test-"));
    const config = makeLazyConfig(dataDir, defaultPorts.postgrestPort);
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const exit = yield* stack.startService("postgrest").pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("while the stack is idle");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });

  it.live("rejects on-demand service starts after stop()", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stack-lifecycle-coordinator-lazy-stopped-test-"));
    const config = makeLazyConfig(dataDir, defaultPorts.postgrestPort);
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start();
      yield* stack.stop();

      const exit = yield* stack.startService("postgrest").pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("while the stack is stopped");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });

  // Regression test: waitAllReady() used to unconditionally delegate to
  // orchestrator.waitAllReady() over the FULL graph startOrder. Under lazyServices, services
  // that were never started (e.g. postgrest, which stays "Pending" until the ApiProxy's
  // ensureService calls startService on first request) never resolve their `healthy` deferred
  // and never emit a Failed state either, so the old implementation hung forever. This is the
  // red test against the pre-fix code: bounded with a short timeout so it fails fast (as a
  // timeout) rather than hanging the suite.
  it.live("waitAllReady() resolves promptly when only postgres was eager-started", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stack-lifecycle-coordinator-lazy-ready-test-"));
    // postgrest is never started in this test, so nothing binds to its configured port; any
    // fixed port is safe here (no EADDRINUSE risk).
    const config = makeLazyConfig(dataDir, defaultPorts.postgrestPort);
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start();

      // postgrest was never started; under the old behavior this would hang because
      // orchestrator.waitAllReady() waits on the full graph, including never-started services.
      yield* stack.waitAllReady().pipe(Effect.timeout(Duration.seconds(5)));

      const postgrestState = yield* stack.getState("postgrest");
      expect(postgrestState.status).toBe("Pending");
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });

  it.live("waitAllReady() covers a service started on demand after start()", () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "stack-lifecycle-coordinator-lazy-ready-started-test-"),
    );

    return Effect.promise(() => startFakeHealthyServer()).pipe(
      Effect.flatMap((fakeServer) => {
        const config = makeLazyConfig(dataDir, fakeServer.port);
        const { layer } = setupLayer(config);

        return Effect.gen(function* () {
          const stack = yield* Stack;
          yield* stack.start();

          // Simulate the ApiProxy's ensureService on-demand path.
          yield* stack.startService("postgrest");

          yield* stack.waitAllReady().pipe(Effect.timeout(Duration.seconds(5)));

          // waitAllReady covering the on-demand service means it reaches ready; the
          // projected status only settles eventually; see helper doc.
          yield* waitForReadyStatus(stack.getState("postgrest"));

          yield* Effect.promise(() => fakeServer.stop());
        }).pipe(Effect.provide(layer));
      }),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });
});
