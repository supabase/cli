import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, ServiceMap, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { defaultPublishableKey, defaultSecretKey, generateJwt } from "./JwtGenerator.ts";
import { StackBuilder } from "./StackBuilder.ts";
import type { BuildResult } from "./StackBuilder.ts";
import type { ResolvedStackConfig } from "./StackBuilder.ts";
import { enabledServicesForConfig, versionsForConfig } from "./StackBuilder.ts";
import { nativePostgresNeedsDockerAccess } from "./StackBuilder.ts";
import type { AllocatedPorts } from "./PortAllocator.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { StackPreparationInput } from "./StackPreparation.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const testJwtSecret = "super-secret-jwt-token-with-at-least-32-characters";

const basePorts: AllocatedPorts = {
  apiPort: 3000,
  dbPort: 5432,
  authPort: 9999,
  postgrestPort: 3001,
  postgrestAdminPort: 3002,
  edgeRuntimePort: 3003,
  edgeRuntimeInspectorPort: 3004,
  realtimePort: 3010,
  storagePort: 3011,
  imgproxyPort: 3012,
  mailpitPort: 3013,
  mailpitSmtpPort: 3014,
  mailpitPop3Port: 3015,
  pgmetaPort: 3016,
  studioPort: 3017,
  analyticsPort: 3018,
  poolerPort: 3019,
  poolerApiPort: 3020,
};

const baseConfig: ResolvedStackConfig = {
  cacheRoot: "/tmp/supabase-cache",
  stackRoot: "/tmp/supabase-stack",
  runtimeRoot: "/tmp/supabase-runtime",
  projectDir: "/tmp/supabase-project",
  mode: "auto",
  jwtSecret: testJwtSecret,
  ports: basePorts,
  apiPort: 3000,
  dbPort: 5432,
  publishableKey: defaultPublishableKey,
  secretKey: defaultSecretKey,
  functions: false,
  autoManagedPaths: [],
  anonJwt: generateJwt(testJwtSecret, "anon"),
  serviceRoleJwt: generateJwt(testJwtSecret, "service_role"),
  postgres: {
    port: 5432,
    dataDir: "/tmp/pg-data",
    version: DEFAULT_VERSIONS.postgres,
    autoExposeNewTables: true,
  },
  postgrest: {
    port: 3001,
    adminPort: 3002,
    schemas: ["public", "extensions"],
    extraSearchPath: ["public"],
    maxRows: 1000,
    version: DEFAULT_VERSIONS.postgrest,
  },
  auth: {
    port: 9999,
    siteUrl: "http://localhost:3000",
    jwtExpiry: 3600,
    externalUrl: "http://localhost:9999",
    version: DEFAULT_VERSIONS.auth,
  },
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

const dockerConfig: ResolvedStackConfig = {
  ...baseConfig,
  mode: "docker",
};

const edgeRuntimeConfig: ResolvedStackConfig = {
  ...baseConfig,
  mode: "auto",
  edgeRuntime: {
    enabled: true,
    port: basePorts.edgeRuntimePort,
    inspectorPort: basePorts.edgeRuntimeInspectorPort,
    policy: "per_worker",
    version: DEFAULT_VERSIONS["edge-runtime"],
    env: {},
  },
};

const encoder = new TextEncoder();

function mockSequenceSpawner(
  results: ReadonlyArray<{ readonly exitCode: number; readonly stderr?: string[] }>,
) {
  let index = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((_command) =>
      Effect.gen(function* () {
        const result = results[index] ?? { exitCode: 0 };
        index += 1;
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode));

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(3000 + index),
          stdout: Stream.empty,
          stderr: Stream.fromIterable(
            (result.stderr ?? []).map((line) => encoder.encode(`${line}\n`)),
          ),
          all: Stream.empty,
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.succeed(true),
          stdin: Sink.drain,
          kill: () => Effect.void,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
}

function builderLayer(
  resolver: ReturnType<typeof mockBinaryResolver>,
  spawnerLayer = mockSequenceSpawner([{ exitCode: 0 }]),
) {
  return Layer.mergeAll(
    StackBuilder.layer,
    StackPreparation.layer.pipe(Layer.provide(resolver.layer), Layer.provide(spawnerLayer)),
  );
}

const prepareAndBuild = (
  builder: ServiceMap.Service.Shape<typeof StackBuilder>,
  preparation: ServiceMap.Service.Shape<typeof StackPreparation>,
  config: ResolvedStackConfig,
): Effect.Effect<BuildResult, unknown> =>
  Effect.gen(function* () {
    const input: StackPreparationInput = {
      mode: config.mode,
      services: enabledServicesForConfig(config),
      versions: versionsForConfig(config),
    };
    const prepared = yield* preparation.prepare(input);
    return yield* builder.build(config, prepared);
  });

describe("StackBuilder", () => {
  it("makes native postgres reachable by docker services on every platform", () => {
    expect(nativePostgresNeedsDockerAccess({ type: "binary", path: "/cache/postgres" }, true)).toBe(
      true,
    );
    expect(
      nativePostgresNeedsDockerAccess({ type: "binary", path: "/cache/postgres" }, false),
    ).toBe(false);
    expect(
      nativePostgresNeedsDockerAccess({ type: "docker", image: "supabase/postgres" }, true),
    ).toBe(false);
  });

  it.effect("builds graph with all native binaries", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph, cleanupTargets, serviceProjection } = yield* prepareAndBuild(
        builder,
        preparation,
        baseConfig,
      );

      expect(graph.startOrder.length).toBe(4);
      expect(cleanupTargets.dockerContainerNames).toEqual([]);

      const names = graph.startOrder.map((s) => s.name);
      expect(names).toContain("postgres");
      expect(names).toContain("postgres-init");
      expect(names).toContain("postgrest");
      expect(names).toContain("auth");

      // Ordering: postgres → postgres-init → [postgrest, auth]
      expect(names.indexOf("postgres")).toBeLessThan(names.indexOf("postgres-init"));
      expect(names.indexOf("postgres-init")).toBeLessThan(names.indexOf("postgrest"));
      expect(names.indexOf("postgres-init")).toBeLessThan(names.indexOf("auth"));

      expect(serviceProjection.get("postgres")).toEqual({ visibility: "public" });
      expect(serviceProjection.get("postgres-init")).toEqual({
        visibility: "internal",
        owner: "postgres",
        ownerStatusWhileActive: "Initializing",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses docker fallback when auth binary not found", () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph } = yield* prepareAndBuild(builder, preparation, baseConfig);

      expect(graph.startOrder.length).toBe(4);

      const authDef = graph.startOrder.find((s) => s.name === "auth");
      expect(authDef).toBeDefined();
      expect(authDef?.command).toBe("docker");
      expect(authDef?.dependencies).toEqual([{ service: "postgres-init", condition: "completed" }]);
      expect(authDef?.supervision).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses docker fallback when postgres binary not found", () => {
    const resolver = mockBinaryResolver({ failServices: ["postgres"] });
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph } = yield* prepareAndBuild(builder, preparation, baseConfig);

      // No postgres-init when postgres falls back to Docker.
      expect(graph.startOrder.length).toBe(3);

      const postgresDef = graph.startOrder.find((s) => s.name === "postgres");
      expect(postgresDef).toBeDefined();
      expect(postgresDef?.command).toBe("docker");
      expect(postgresDef?.supervision).toBeDefined();

      // postgrest falls back to postgres(healthy) dependency
      const postgrestDef = graph.startOrder.find((s) => s.name === "postgrest");
      expect(postgrestDef?.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);

      const names = graph.startOrder.map((s) => s.name);
      expect(names).not.toContain("postgres-init");
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses docker fallback when postgrest binary not found", () => {
    const resolver = mockBinaryResolver({ failServices: ["postgrest"] });
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph } = yield* prepareAndBuild(builder, preparation, baseConfig);

      // All 4 services still present (postgrest falls back to Docker, not removed)
      expect(graph.startOrder.length).toBe(4);

      const postgrestDef = graph.startOrder.find((s) => s.name === "postgrest");
      expect(postgrestDef).toBeDefined();
      expect(postgrestDef?.command).toBe("docker");
      expect(postgrestDef?.supervision).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("excludes disabled services", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph } = yield* prepareAndBuild(builder, preparation, {
        ...baseConfig,
        auth: false,
      });

      // postgres + postgres-init + postgrest (no auth)
      expect(graph.startOrder.length).toBe(3);
      const names = graph.startOrder.map((s) => s.name);
      expect(names).toContain("postgres");
      expect(names).toContain("postgres-init");
      expect(names).toContain("postgrest");
      expect(names).not.toContain("auth");
    }).pipe(Effect.provide(layer));
  });

  it.effect("docker mode produces Docker service defs for all services", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph, cleanupTargets } = yield* prepareAndBuild(builder, preparation, dockerConfig);

      expect(graph.startOrder.length).toBe(3);

      const names = graph.startOrder.map((s) => s.name);
      expect(names).toContain("postgres");
      expect(names).not.toContain("postgres-init");
      expect(names).toContain("postgrest");
      expect(names).toContain("auth");

      // All Docker-backed services launch directly and rely on process-compose
      // supervision for abrupt parent-exit cleanup.
      for (const name of ["postgres", "postgrest", "auth"]) {
        const def = graph.startOrder.find((s) => s.name === name);
        expect(def).toBeDefined();
        expect(def?.command).toBe("docker");
        expect(def?.supervision).toBeDefined();
      }

      // Docker container names are collected for cleanup
      expect(cleanupTargets.dockerContainerNames).toEqual([
        `supabase-postgres-${dockerConfig.apiPort}`,
        `supabase-postgrest-${dockerConfig.apiPort}`,
        `supabase-auth-${dockerConfig.apiPort}`,
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("docker mode wires auth directly to postgres readiness", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph } = yield* prepareAndBuild(builder, preparation, dockerConfig);

      const authDef = graph.startOrder.find((s) => s.name === "auth");
      expect(authDef?.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("docker mode has no postgres-init service for Docker postgres", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph } = yield* prepareAndBuild(builder, preparation, dockerConfig);

      const names = graph.startOrder.map((s) => s.name);
      expect(names).not.toContain("postgres-init");
    }).pipe(Effect.provide(layer));
  });

  it.effect("docker mode wires dependencies correctly", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph } = yield* prepareAndBuild(builder, preparation, dockerConfig);

      const authDef = graph.startOrder.find((s) => s.name === "auth");
      expect(authDef?.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);

      // postgrest depends on postgres(healthy) — no postgres-init in Docker mode
      const postgrestDef = graph.startOrder.find((s) => s.name === "postgrest");
      expect(postgrestDef?.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses docker-backed edge-runtime even when a native binary is available", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph, cleanupTargets } = yield* prepareAndBuild(
        builder,
        preparation,
        edgeRuntimeConfig,
      );

      const edgeRuntimeDef = graph.startOrder.find((service) => service.name === "edge-runtime");
      expect(edgeRuntimeDef).toBeDefined();
      expect(edgeRuntimeDef?.command).toBe("docker");
      expect(edgeRuntimeDef?.dependencies).toEqual([
        { service: "postgres-init", condition: "completed" },
      ]);
      expect(cleanupTargets.dockerContainerNames).toContain(
        `supabase-edge-runtime-${edgeRuntimeConfig.apiPort}`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses docker-backed edge-runtime when the binary is unavailable", () => {
    const resolver = mockBinaryResolver({ failServices: ["edge-runtime"] });
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph, cleanupTargets } = yield* prepareAndBuild(
        builder,
        preparation,
        edgeRuntimeConfig,
      );

      const edgeRuntimeDef = graph.startOrder.find((service) => service.name === "edge-runtime");
      expect(edgeRuntimeDef).toBeDefined();
      expect(edgeRuntimeDef?.command).toBe("docker");
      expect(edgeRuntimeDef?.dependencies).toEqual([
        { service: "postgres-init", condition: "completed" },
      ]);
      expect(cleanupTargets.dockerContainerNames).toContain(
        `supabase-edge-runtime-${edgeRuntimeConfig.apiPort}`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the next registry for docker-only services", () => {
    const resolver = mockBinaryResolver();
    const spawnerLayer = mockSequenceSpawner([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 1, stderr: ["manifest unknown"] },
      { exitCode: 0 },
    ]);
    const layer = builderLayer(resolver, spawnerLayer);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph } = yield* prepareAndBuild(builder, preparation, {
        ...dockerConfig,
        realtime: {
          port: 3010,
          version: DEFAULT_VERSIONS.realtime,
          tenantId: "realtime-dev",
          encryptionKey: "supabaserealtime",
          secretKeyBase: "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
          maxHeaderLength: 4096,
        },
      });

      const realtimeDef = graph.startOrder.find((service) => service.name === "realtime");
      expect(realtimeDef?.args).toContain("supabase/realtime:v2.78.10");
      expect(realtimeDef?.args).not.toContain("public.ecr.aws/supabase/realtime:v2.78.10");
    }).pipe(Effect.provide(layer));
  });
});
