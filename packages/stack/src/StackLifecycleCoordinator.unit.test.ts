import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { mockChildProcessSpawner } from "../../process-compose/tests/helpers/mocks.ts";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { defaultPublishableKey, defaultSecretKey, generateJwt } from "./JwtGenerator.ts";
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

  return { layer };
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
});
