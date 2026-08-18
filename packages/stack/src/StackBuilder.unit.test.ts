import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { defaultPublishableKey, defaultSecretKey, generateJwt } from "./JwtGenerator.ts";
import { candidateCleanupTargets } from "./cleanup.ts";
import { StackBuilder, validateResolvedConfig } from "./StackBuilder.ts";
import type { BuildResult } from "./StackBuilder.ts";
import { DEFAULT_STACK_READINESS_POLICY, type ResolvedStackConfig } from "./StackConfig.ts";
import { STACK_ID_LABEL } from "./StackIdentity.ts";
import { enabledServicesForConfig, versionsForConfig } from "./StackBuilder.ts";
import type { AllocatedPorts } from "./PortCatalog.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { StackPreparationInput } from "./StackPreparation.ts";
import {
  dependencyTimeoutSecondsForServices,
  POSTGRES_INIT_COMPLETION_BUDGET_SECONDS,
} from "./services/health-budgets.ts";
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
  mode: "native",
  containerRuntime: null,
  servicePolicies: {
    postgres: "eager",
    postgrest: "eager",
    auth: "eager",
    "edge-runtime": "off",
    realtime: "off",
    storage: "off",
    imgproxy: "off",
    mailpit: "off",
    pgmeta: "off",
    studio: "off",
    analytics: "off",
    vector: "off",
    pooler: "off",
  },
  readiness: DEFAULT_STACK_READINESS_POLICY,
  readinessSource: "default",
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
  containerRuntime: "docker",
};

/**
 * Two stacks that were handed their own identities while sharing every port,
 * which is what sibling worktrees of one project look like when a crashed stack
 * left its containers behind and its ports free.
 */
const firstManagedId = "3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const secondManagedId = "9e8d7c6b-5a49-4382-9170-f6e5d4c3b2a1";

const managedConfig: ResolvedStackConfig = {
  ...dockerConfig,
  instanceId: firstManagedId,
};

const siblingManagedConfig: ResolvedStackConfig = {
  ...dockerConfig,
  instanceId: secondManagedId,
};

const edgeRuntimeConfig: ResolvedStackConfig = {
  ...baseConfig,
  mode: "docker",
  containerRuntime: "docker",
  servicePolicies: { ...baseConfig.servicePolicies, "edge-runtime": "eager" },
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
          unref: Effect.succeed(Effect.void),
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
  builder: typeof StackBuilder.Service,
  preparation: typeof StackPreparation.Service,
  config: ResolvedStackConfig,
): Effect.Effect<BuildResult, unknown> =>
  Effect.gen(function* () {
    const shared = {
      services: enabledServicesForConfig(config),
      versions: versionsForConfig(config),
    };
    const input: StackPreparationInput =
      config.mode === "native"
        ? { ...shared, mode: "native" }
        : config.containerRuntime === null
          ? yield* Effect.die("Docker test config is missing its container runtime")
          : { ...shared, mode: "docker", containerRuntime: config.containerRuntime };
    const prepared = yield* preparation.prepare(input);
    return yield* builder.build(config, prepared);
  });

describe("StackBuilder", () => {
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
      expect(candidateCleanupTargets(baseConfig).dockerContainerNames).toEqual([
        `supabase-postgres-${baseConfig.apiPort}`,
        `supabase-postgrest-${baseConfig.apiPort}`,
        `supabase-auth-${baseConfig.apiPort}`,
      ]);

      const names = graph.startOrder.map((s) => s.name);
      expect(names).toContain("postgres");
      expect(names).toContain("postgres-init");
      expect(names).toContain("postgrest");
      expect(names).toContain("auth");

      // Ordering: postgres → postgres-init → [postgrest, auth]
      expect(names.indexOf("postgres")).toBeLessThan(names.indexOf("postgres-init"));
      expect(names.indexOf("postgres-init")).toBeLessThan(names.indexOf("postgrest"));
      expect(names.indexOf("postgres-init")).toBeLessThan(names.indexOf("auth"));

      const postgresDependencyTimeout = dependencyTimeoutSecondsForServices(["postgres"]);
      expect(
        graph.startOrder.find((service) => service.name === "postgres-init")
          ?.dependencyTimeoutSeconds,
      ).toBe(postgresDependencyTimeout);
      for (const name of ["postgrest", "auth"]) {
        expect(
          graph.startOrder.find((service) => service.name === name)?.dependencyTimeoutSeconds,
        ).toBe(postgresDependencyTimeout + POSTGRES_INIT_COMPLETION_BUDGET_SECONDS);
      }

      expect(serviceProjection.get("postgres")).toEqual({ visibility: "public" });
      expect(serviceProjection.get("postgres-init")).toEqual({
        visibility: "internal",
        owner: "postgres",
        ownerStatusWhileActive: "Initializing",
      });
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

  it.effect("Docker mode consistently uses the selected container runtime", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const config = { ...dockerConfig, containerRuntime: "podman" } satisfies ResolvedStackConfig;
      const { graph, cleanupTargets } = yield* prepareAndBuild(builder, preparation, config);

      expect(graph.startOrder.length).toBe(4);

      const names = graph.startOrder.map((s) => s.name);
      expect(names).toContain("postgres");
      expect(names).toContain("postgres-init");
      expect(names).toContain("postgrest");
      expect(names).toContain("auth");

      // All Docker-backed services launch directly and rely on process-compose
      // supervision for abrupt parent-exit cleanup.
      for (const name of ["postgres", "postgrest", "auth"]) {
        const def = graph.startOrder.find((s) => s.name === name);
        expect(def).toBeDefined();
        expect(def?.command).toBe("podman");
        expect(def?.supervision).toBeDefined();
        expect(def?.supervision?.orphanCleanup).toContainEqual(
          expect.objectContaining({ executable: "podman" }),
        );
      }

      // Docker container names are collected for cleanup
      expect(cleanupTargets.dockerContainerNames).toEqual([
        `supabase-postgres-${config.apiPort}`,
        `supabase-postgrest-${config.apiPort}`,
        `supabase-auth-${config.apiPort}`,
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("names and labels a stack's containers by the identity it was given", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph, cleanupTargets } = yield* prepareAndBuild(builder, preparation, managedConfig);

      expect(cleanupTargets.dockerContainerNames).toEqual([
        `supabase-postgres-id-${firstManagedId}`,
        `supabase-postgrest-id-${firstManagedId}`,
        `supabase-auth-id-${firstManagedId}`,
      ]);
      expect(candidateCleanupTargets(managedConfig).dockerContainerNames).toEqual(
        cleanupTargets.dockerContainerNames,
      );
      // Nothing about the stack's Docker resources is keyed by a port any more,
      // so a stack that reuses this one's ports cannot collide with it.
      for (const name of cleanupTargets.dockerContainerNames) {
        expect(name).not.toContain(String(managedConfig.apiPort));
      }

      for (const def of graph.startOrder.filter((service) => service.args?.[0] === "run")) {
        expect(def.args).toContain(`supabase-${def.name}-id-${firstManagedId}`);
        // The label carries the whole identity, so the containers stay findable
        // by it even if the names are ever built differently.
        expect(def.args?.join(" ")).toContain(`--label ${STACK_ID_LABEL}=${firstManagedId}`);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an invalid instanceId supplied to the builder directly", () => {
    return Effect.gen(function* () {
      const error = yield* validateResolvedConfig({
        ...dockerConfig,
        instanceId: "../bad:id",
      }).pipe(Effect.flip);

      expect(error._tag).toBe("StackBuildError");
      expect(error.reason).toBe("invalid_config");
    });
  });

  it.effect("keeps sibling stacks sharing every port on separate containers", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const first = yield* prepareAndBuild(builder, preparation, managedConfig);
      const sibling = yield* prepareAndBuild(builder, preparation, siblingManagedConfig);

      expect(siblingManagedConfig.apiPort).toBe(managedConfig.apiPort);
      const shared = first.cleanupTargets.dockerContainerNames.filter((name) =>
        sibling.cleanupTargets.dockerContainerNames.includes(name),
      );
      expect(shared).toEqual([]);
      expect(sibling.cleanupTargets.dockerContainerNames).toEqual([
        `supabase-postgres-id-${secondManagedId}`,
        `supabase-postgrest-id-${secondManagedId}`,
        `supabase-auth-id-${secondManagedId}`,
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves a stack without an identity on its port-derived names", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph, cleanupTargets } = yield* prepareAndBuild(builder, preparation, dockerConfig);

      expect(cleanupTargets.dockerContainerNames).toEqual([
        `supabase-postgres-${dockerConfig.apiPort}`,
        `supabase-postgrest-${dockerConfig.apiPort}`,
        `supabase-auth-${dockerConfig.apiPort}`,
      ]);
      for (const def of graph.startOrder.filter((service) => service.args?.[0] === "run")) {
        expect(def.args).toContain(`supabase-${def.name}-${dockerConfig.apiPort}`);
        expect(def.args?.join(" ")).not.toContain(STACK_ID_LABEL);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("docker consumers wait for database initialization", () => {
    const resolver = mockBinaryResolver();
    const layer = builderLayer(resolver);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const preparation = yield* StackPreparation;
      const { graph } = yield* prepareAndBuild(builder, preparation, dockerConfig);

      const authDef = graph.startOrder.find((s) => s.name === "auth");
      expect(authDef?.dependencies).toEqual([{ service: "postgres-init", condition: "completed" }]);
      expect(authDef?.dependencyTimeoutSeconds).toBe(
        dependencyTimeoutSecondsForServices(["postgres"]) + POSTGRES_INIT_COMPLETION_BUDGET_SECONDS,
      );
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
      expect(authDef?.dependencies).toEqual([{ service: "postgres-init", condition: "completed" }]);

      const postgrestDef = graph.startOrder.find((s) => s.name === "postgrest");
      expect(postgrestDef?.dependencies).toEqual([
        { service: "postgres-init", condition: "completed" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses Docker for edge-runtime and its dependencies in Docker mode", () => {
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
});
