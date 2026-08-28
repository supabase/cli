// oxlint-disable effecttsgo/async-function, effecttsgo/global-date-in-effect, effecttsgo/new-promise, effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json, effecttsgo/run-effect-inside-effect -- Stack tests exercise native HTTP/filesystem fixtures and use direct runtime evaluation for synchronous lifecycle assertions.

import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { buildGraph, ServiceNotFoundError } from "@supabase/process-compose";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Stream } from "effect";
import { mockChildProcessSpawner } from "../../process-compose/tests/helpers/mocks.ts";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { StackBuildError, StackReadinessError } from "./errors.ts";
import { defaultPublishableKey, defaultSecretKey, generateJwt } from "./JwtGenerator.ts";
import { functionsRuntimeConfigPath, type ResolvedFunctionsBundle } from "./functions.ts";
import type { AllocatedPorts, PortField, ResolvedPorts } from "./PortCatalog.ts";
import type { PortLease } from "./PortAllocator.ts";
import { StackServiceActivator } from "./ServiceActivation.ts";
import { Stack } from "./Stack.ts";
import { attachReadinessDiagnostics, localStackLayer } from "./LocalStack.ts";
import { StackPreparation } from "./StackPreparation.ts";
import { StackBuilder } from "./StackBuilder.ts";
import { DEFAULT_STACK_READINESS_POLICY, type ResolvedStackConfig } from "./StackConfig.ts";
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

const defaultConfig: ResolvedStackConfig = {
  cacheRoot: "/tmp/supabase-cache",
  stackRoot: "/tmp/supabase-stack",
  runtimeRoot: "/tmp/supabase-runtime",
  projectDir: "/tmp/supabase-project",
  runtime: { mode: "native", containerRuntime: null },
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
    dataDir: "/tmp/supabase/data",
    version: DEFAULT_VERSIONS.postgres,
    autoExposeNewTables: true,
  },
  postgrest: {
    port: 54323,
    adminPort: 54324,
    schemas: ["public", "storage", "graphql_public"],
    extraSearchPath: ["public", "extensions"],
    maxRows: 1000,
    version: DEFAULT_VERSIONS.postgrest,
  },
  auth: {
    port: 9999,
    siteUrl: "http://localhost:3000",
    jwtExpiry: 3600,
    externalUrl: "http://127.0.0.1:54321",
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

const edgeRuntimeConfig: ResolvedStackConfig = {
  ...defaultConfig,
  runtime: { mode: "docker", containerRuntime: "docker" },
  servicePolicies: { ...defaultConfig.servicePolicies, "edge-runtime": "eager" },
  edgeRuntime: {
    enabled: true,
    port: defaultPorts.edgeRuntimePort,
    inspectorPort: defaultPorts.edgeRuntimeInspectorPort,
    policy: "per_worker",
    version: DEFAULT_VERSIONS["edge-runtime"],
    env: {},
  },
};

const functionsBundle = (root: string, value: string): ResolvedFunctionsBundle => ({
  env: { SHARED: value },
  functions: [
    {
      name: "hello",
      verifyJWT: false,
      entrypointPath: join(root, "hello", "index.ts"),
      importMapPath: null,
      staticFiles: [],
      env: { FUNCTION_VALUE: value },
    },
  ],
});

const noopPortLease = (ports: ResolvedPorts): PortLease => ({
  ports,
  reserve: () => Effect.void,
  release: () => Effect.void,
  releaseAll: Effect.void,
});

function setupLayer(
  config: ResolvedStackConfig = defaultConfig,
  portLease: PortLease = noopPortLease(config.ports),
  spawner = mockChildProcessSpawner(),
  resolver = mockBinaryResolver(),
) {
  const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(resolver.layer));
  const layer = localStackLayer(config, portLease).pipe(
    Layer.provide(StackBuilder.layer),
    Layer.provide(stackPreparationLayer),
    Layer.provide(spawner.layer),
    Layer.provide(NodeServices.layer),
  );

  return { layer, resolver, spawner };
}

describe("Stack", () => {
  it.effect("preserves defects and interruption while collecting readiness diagnostics", () =>
    Effect.gen(function* () {
      const readinessError = new StackReadinessError({
        target: "stack",
        timeoutMs: 10,
        detail: "Timed out waiting for stack readiness",
      });
      const defect = new Error("diagnostic state collection failed");

      const defectExit = yield* attachReadinessDiagnostics(
        readinessError,
        Effect.die(defect),
        Effect.succeed([]),
      ).pipe(Effect.exit);
      const interruptionExit = yield* attachReadinessDiagnostics(
        readinessError,
        Effect.interrupt,
        Effect.succeed([]),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(defectExit)).toBe(true);
      if (Exit.isFailure(defectExit)) {
        expect(Cause.squash(defectExit.cause)).toBe(defect);
      }
      expect(Exit.isFailure(interruptionExit)).toBe(true);
      if (Exit.isFailure(interruptionExit)) {
        expect(Cause.hasInterruptsOnly(interruptionExit.cause)).toBe(true);
      }
    }),
  );

  it.effect("getInfo returns correct URLs based on config", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const info = yield* stack.getInfo;

      expect(info.url).toBe("http://127.0.0.1:54321");
      expect(info.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
      expect(info.serviceEndpoints.auth).toBe("http://127.0.0.1:54321/auth/v1");
      expect(info.serviceEndpoints.postgrest).toBe("http://127.0.0.1:54321/rest/v1");
    }).pipe(Effect.provide(layer));
  });

  it.effect("getInfo includes functions and edge runtime endpoints when enabled", () => {
    const { layer } = setupLayer(edgeRuntimeConfig);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const info = yield* stack.getInfo;

      expect(info.serviceEndpoints.functions).toBe("http://127.0.0.1:54321/functions/v1");
      expect(info.serviceEndpoints.edge_runtime).toBe("http://127.0.0.1:54321/functions/v1");
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves current Functions and Edge Runtime settings across partial reloads", () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "supabase-functions-reload-"));
    const initialBundle = functionsBundle(runtimeRoot, "initial-secret");
    const replacementBundle = functionsBundle(runtimeRoot, "replacement-secret");
    const config = {
      ...edgeRuntimeConfig,
      projectDir: runtimeRoot,
      runtimeRoot,
      functions: initialBundle,
      postgrest: false,
      auth: false,
      servicePolicies: {
        ...edgeRuntimeConfig.servicePolicies,
        postgrest: "off",
        auth: "off",
        "edge-runtime": "lazy",
      },
    } satisfies ResolvedStackConfig;
    const graph = Effect.runSync(
      buildGraph([
        {
          name: "postgres",
          command: process.execPath,
          restart: "unless-stopped",
        },
        {
          name: "edge-runtime",
          command: process.execPath,
          restart: "unless-stopped",
        },
      ]),
    );
    const builtConfigs: ResolvedStackConfig[] = [];
    const builderLayer = Layer.succeed(StackBuilder, {
      build: (candidate) =>
        Effect.sync(() => {
          builtConfigs.push(candidate);
          return {
            graph,
            cleanupTargets: { dockerContainerNames: [] },
            serviceProjection: new Map([
              ["postgres", { visibility: "public" as const }],
              ["edge-runtime", { visibility: "public" as const }],
            ]),
          };
        }),
    });
    const resolver = mockBinaryResolver();
    const layer = localStackLayer(config, noopPortLease(config.ports)).pipe(
      Layer.provide(builderLayer),
      Layer.provide(StackPreparation.layer.pipe(Layer.provide(resolver.layer))),
      Layer.provide(mockChildProcessSpawner().layer),
      Layer.provide(NodeServices.layer),
    );
    const readRuntimeConfig = Effect.promise(() =>
      readFile(functionsRuntimeConfigPath(runtimeRoot), "utf8").then((contents) =>
        JSON.parse(contents),
      ),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start;
      expect((yield* stack.getState("edge-runtime")).status).toBe("Dormant");

      yield* stack.reloadFunctions({ functions: replacementBundle });
      expect((yield* stack.getState("edge-runtime")).status).toBe("Healthy");
      expect((yield* readRuntimeConfig).env.SHARED).toBe("replacement-secret");

      yield* stack.reloadEdgeRuntime({ edgeRuntime: { policy: "oneshot" } });
      expect((yield* readRuntimeConfig).env.SHARED).toBe("replacement-secret");

      yield* stack.reloadEdgeRuntime({ edgeRuntime: { env: { NEXT: "next-value" } } });
      expect(builtConfigs.at(-1)?.edgeRuntime).toMatchObject({
        policy: "oneshot",
        env: { NEXT: "next-value" },
      });

      yield* stack.reloadFunctions();
      expect((yield* readRuntimeConfig).env.SHARED).toBe("replacement-secret");

      const duplicateBundle = {
        ...replacementBundle,
        functions: [replacementBundle.functions[0]!, replacementBundle.functions[0]!],
      };
      expect(
        Predicate.isTagged(
          yield* stack.reloadFunctions({ functions: duplicateBundle }).pipe(Effect.flip),
          "StackBuildError",
        ),
      ).toBe(true);
      expect((yield* readRuntimeConfig).env.SHARED).toBe("replacement-secret");

      // Replace the workspace directory with a plain file so the config write
      // fails for any user — permission bits alone are bypassed by root.
      const runtimeDirectory = join(runtimeRoot, "edge-runtime");
      yield* Effect.promise(async () => {
        await rm(runtimeDirectory, { recursive: true, force: true });
        await writeFile(runtimeDirectory, "");
      });
      const failedBundle = functionsBundle(runtimeRoot, "failed-secret");
      const error = yield* stack.reloadFunctions({ functions: failedBundle }).pipe(Effect.flip);
      expect(Predicate.isTagged(error, "StackBuildError")).toBe(true);

      yield* Effect.promise(() => rm(runtimeDirectory));
      yield* stack.reloadFunctions();
      expect((yield* readRuntimeConfig).env.SHARED).toBe("replacement-secret");

      yield* stack.dispose;
      expect(
        yield* Effect.promise(() =>
          readFile(functionsRuntimeConfigPath(runtimeRoot), "utf8").then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.promise(() => rm(runtimeRoot, { recursive: true, force: true }))),
      Effect.timeout("5 seconds"),
    );
  });

  it.live("merges overlapping function and Edge Runtime reloads", () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "supabase-functions-reload-race-"));
    const initialBundle = functionsBundle(runtimeRoot, "initial-secret");
    const replacementBundle = functionsBundle(runtimeRoot, "replacement-secret");
    const config = {
      ...edgeRuntimeConfig,
      projectDir: runtimeRoot,
      runtimeRoot,
      functions: initialBundle,
      postgrest: false,
      auth: false,
      servicePolicies: {
        ...edgeRuntimeConfig.servicePolicies,
        postgrest: "off",
        auth: "off",
        "edge-runtime": "lazy",
      },
    } satisfies ResolvedStackConfig;
    const graph = Effect.runSync(
      buildGraph([
        { name: "postgres", command: process.execPath, restart: "unless-stopped" },
        { name: "edge-runtime", command: process.execPath, restart: "unless-stopped" },
      ]),
    );
    const builderLayer = Layer.succeed(StackBuilder, {
      build: () =>
        Effect.sync(() => {
          return {
            graph,
            cleanupTargets: { dockerContainerNames: [] },
            serviceProjection: new Map([
              ["postgres", { visibility: "public" as const }],
              ["edge-runtime", { visibility: "public" as const }],
            ]),
          };
        }),
    });
    const preparationStarted = Deferred.makeUnsafe<void>();
    const allowPreparation = Deferred.makeUnsafe<void>();
    let blockNextSpawn = false;
    const resolver = mockBinaryResolver();
    const spawner = mockChildProcessSpawner({
      beforeSpawn: () => {
        if (!blockNextSpawn) return Effect.void;
        blockNextSpawn = false;
        return Deferred.succeed(preparationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowPreparation)),
        );
      },
    });
    const layer = localStackLayer(config, noopPortLease(config.ports)).pipe(
      Layer.provide(builderLayer),
      Layer.provide(StackPreparation.layer.pipe(Layer.provide(resolver.layer))),
      Layer.provide(spawner.layer),
      Layer.provide(NodeServices.layer),
    );
    const readRuntimeConfig = Effect.promise(() =>
      readFile(functionsRuntimeConfigPath(runtimeRoot), "utf8").then((contents) =>
        JSON.parse(contents),
      ),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start;
      blockNextSpawn = true;

      const functionsReload = yield* stack
        .reloadFunctions({ functions: replacementBundle })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(preparationStarted);

      // Both requests join the same gated preparation before either can commit.
      // The later Edge Runtime commit must preserve the Functions update.
      const edgeReload = yield* stack
        .reloadEdgeRuntime({ edgeRuntime: { env: { CONCURRENT: "edge-value" } } })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(allowPreparation, undefined);
      yield* Fiber.join(functionsReload);
      yield* Fiber.join(edgeReload);

      expect((yield* readRuntimeConfig).env.SHARED).toBe("replacement-secret");
      expect((yield* stack.getState("edge-runtime")).status).toBe("Healthy");
      yield* stack.dispose;
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.promise(() => rm(runtimeRoot, { recursive: true, force: true }))),
      Effect.timeout("5 seconds"),
    );
  });

  it.effect("getInfo returns valid JWT tokens", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const info = yield* stack.getInfo;

      expect(info.anonJwt).toBeDefined();
      expect(info.serviceRoleJwt).toBeDefined();

      // Verify anon JWT structure
      const anonParts = info.anonJwt.split(".");
      expect(anonParts).toHaveLength(3);

      const anonHeader = JSON.parse(Buffer.from(anonParts[0]!, "base64url").toString());
      expect(anonHeader.alg).toBe("HS256");
      expect(anonHeader.typ).toBe("JWT");

      const anonPayload = JSON.parse(Buffer.from(anonParts[1]!, "base64url").toString());
      expect(anonPayload.role).toBe("anon");
      expect(anonPayload.iss).toBe("supabase");
      expect(anonPayload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

      // Verify service_role JWT structure
      const serviceRoleParts = info.serviceRoleJwt.split(".");
      expect(serviceRoleParts).toHaveLength(3);

      const serviceRolePayload = JSON.parse(
        Buffer.from(serviceRoleParts[1]!, "base64url").toString(),
      );
      expect(serviceRolePayload.role).toBe("service_role");
      expect(serviceRolePayload.iss).toBe("supabase");
      expect(serviceRolePayload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }).pipe(Effect.provide(layer));
  });

  it.effect("JWT tokens use the configured jwtSecret", () => {
    const secret = "super-secret-jwt-token-with-at-least-32-characters-long";
    const { layer } = setupLayer({ ...defaultConfig, jwtSecret: secret });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const info = yield* stack.getInfo;

      // Verify that the signature is valid by re-signing with the same secret
      const verifyToken = (token: string): boolean => {
        const parts = token.split(".");
        if (parts.length !== 3) return false;
        const data = `${parts[0]}.${parts[1]}`;
        const expectedSig = createHmac("sha256", secret).update(data).digest("base64url");
        return parts[2] === expectedSig;
      };

      expect(verifyToken(info.anonJwt)).toBe(true);
      expect(verifyToken(info.serviceRoleJwt)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("getInfo returns consistent info on multiple calls", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const info1 = yield* stack.getInfo;
      const info2 = yield* stack.getInfo;

      expect(info1.url).toBe(info2.url);
      expect(info1.dbUrl).toBe(info2.dbUrl);
      // JWT tokens are generated at construction time so they should be identical
      expect(info1.anonJwt).toBe(info2.anonJwt);
      expect(info1.serviceRoleJwt).toBe(info2.serviceRoleJwt);
    }).pipe(Effect.provide(layer));
  });

  it.effect("getInfo returns publishableKey and secretKey", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const info = yield* stack.getInfo;

      expect(info.publishableKey).toBeDefined();
      expect(info.secretKey).toBeDefined();
      // Without custom keys in config, should fall back to defaults
      expect(info.publishableKey).toBe(defaultPublishableKey);
      expect(info.secretKey).toBe(defaultSecretKey);
    }).pipe(Effect.provide(layer));
  });

  it.effect("getInfo returns custom publishableKey and secretKey when provided", () => {
    const customConfig: ResolvedStackConfig = {
      ...defaultConfig,
      publishableKey: "sb_publishable_custom_key",
      secretKey: "sb_secret_custom_key",
    };
    const { layer } = setupLayer(customConfig);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const info = yield* stack.getInfo;

      expect(info.publishableKey).toBe("sb_publishable_custom_key");
      expect(info.secretKey).toBe("sb_secret_custom_key");
    }).pipe(Effect.provide(layer));
  });

  it.effect("getAllStates returns projected public states", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const states = yield* stack.getAllStates;

      expect(states).toHaveLength(3);

      const names = states.map((s) => s.name);
      expect(names).toContain("postgres");
      expect(names).toContain("postgrest");
      expect(names).toContain("auth");

      const postgres = states.find((state) => state.name === "postgres");
      expect(postgres?.status).toBe("Pending");

      for (const state of states) {
        expect(state.pid).toBeNull();
        expect(state.exitCode).toBeNull();
        expect(state.restartCount).toBe(0);
        expect(state.startedAt).toBeNull();
        expect(state.error).toBeNull();
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("getAllStates includes edge-runtime when enabled", () => {
    const { layer } = setupLayer(edgeRuntimeConfig);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const states = yield* stack.getAllStates;

      expect(states.map((state) => state.name)).toContain("edge-runtime");
    }).pipe(Effect.provide(layer));
  });

  it.live("starts the readiness deadline after artifact preparation", () => {
    const resolver = mockBinaryResolver({
      downloadedServices: ["postgres"],
      downloadDelayMs: 300,
    });
    const spawner = mockChildProcessSpawner();
    const config = {
      ...defaultConfig,
      postgrest: false,
      auth: false,
      readiness: { mode: "finite", timeoutMs: 250 },
      readinessSource: "configured",
    } satisfies ResolvedStackConfig;
    const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(resolver.layer));
    const layer = localStackLayer(config, noopPortLease(config.ports)).pipe(
      Layer.provide(StackBuilder.layer),
      Layer.provide(stackPreparationLayer),
      Layer.provide(spawner.layer),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const startedAt = Date.now();
      const exit = yield* stack.start.pipe(Effect.exit);

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.timeout("5 seconds"));
  });

  it.effect("getState fails for internal helper services", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const exit = yield* stack.getState("postgres-init").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("logHistory returns empty array initially", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const logs = yield* stack.logHistory("postgres");

      expect(logs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("logHistoryAll returns empty array initially", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const logs = yield* stack.logHistoryAll();

      expect(logs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects unknown services across every log operation", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const history = yield* stack.logHistory("missing").pipe(Effect.flip);
      expect(history).toBeInstanceOf(ServiceNotFoundError);

      const historyAll = yield* stack.logHistoryAll(undefined, ["missing"]).pipe(Effect.flip);
      expect(historyAll).toBeInstanceOf(ServiceNotFoundError);

      const subscription = yield* Stream.runCollect(stack.subscribeLogs("missing")).pipe(
        Effect.flip,
      );
      expect(subscription).toBeInstanceOf(ServiceNotFoundError);

      const subscriptions = yield* Stream.runCollect(stack.subscribeAllLogs(["missing"])).pipe(
        Effect.flip,
      );
      expect(subscriptions).toBeInstanceOf(ServiceNotFoundError);
    }).pipe(Effect.provide(layer));
  });

  it.live("startService fails with ServiceNotFoundError for unknown service", () => {
    const config = {
      ...defaultConfig,
      servicePolicies: {
        ...defaultConfig.servicePolicies,
        postgrest: "lazy",
        auth: "lazy",
      },
    } satisfies ResolvedStackConfig;
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start;
      const exit = yield* stack.startService("nonexistent").pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "ServiceNotFoundError" });
      }
    }).pipe(Effect.provide(layer));
  });

  // Regression guard for https://github.com/supabase/cli/issues/5068: image
  // acquisition must complete during preparation, so a failed pull aborts start
  // instead of letting containers come up before their images are ready.
  // it.live is required because the mock spawner resolves exit codes on the real
  // clock; it.effect's TestClock would leave those sleeps pending.
  it.live("start fails and never starts containers when a docker image pull fails", () => {
    // Fail binary resolution so every service falls back to Docker, then fail
    // every spawned docker command (image inspect + pull).
    const resolver = mockBinaryResolver({ failServices: ["postgres", "postgrest", "auth"] });
    const spawner = mockChildProcessSpawner({ exitCode: 1 });
    const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(resolver.layer));
    const layer = localStackLayer(defaultConfig, noopPortLease(defaultConfig.ports)).pipe(
      Layer.provide(StackBuilder.layer),
      Layer.provide(stackPreparationLayer),
    );
    const providedLayer = layer.pipe(
      Layer.provide(spawner.layer),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const exit = yield* stack.start.pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      // No container was ever started: only prepare-phase docker commands ran.
      const startedContainers = spawner.spawned.filter((record) => record.args[0] === "run");
      expect(startedContainers).toEqual([]);
    }).pipe(Effect.provide(providedLayer));
  });

  it.live("disposal fails a cold eager start with a typed build error", () => {
    return Effect.gen(function* () {
      const preparationStarted = yield* Deferred.make<void>();
      const resolver = mockBinaryResolver({
        downloadedServices: ["auth"],
        beforeResolve: ({ service }) =>
          service === "auth"
            ? Deferred.succeed(preparationStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const { layer } = setupLayer(
        defaultConfig,
        noopPortLease(defaultConfig.ports),
        undefined,
        resolver,
      );

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const starting = yield* stack.start.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(preparationStarted);

        const disposing = yield* stack.dispose.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(disposing);

        const startExit = yield* Fiber.await(starting);
        expect(Exit.isFailure(startExit)).toBe(true);
        if (Exit.isFailure(startExit)) {
          expect(Cause.squash(startExit.cause)).toMatchObject({ _tag: "StackBuildError" });
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds"));
  });

  it.live("can retry start after a build failure before services start", () => {
    let buildAttempts = 0;
    const graph = Effect.runSync(
      buildGraph([{ name: "postgres", command: "true", restart: "no" }]),
    );
    const builderLayer = Layer.succeed(StackBuilder, {
      build: () =>
        Effect.suspend(() => {
          buildAttempts += 1;
          return buildAttempts === 1
            ? Effect.fail(new StackBuildError({ detail: "transient build failure" }))
            : Effect.succeed({
                graph,
                cleanupTargets: { dockerContainerNames: [] },
                serviceProjection: new Map<string, { readonly visibility: "public" }>([
                  ["postgres", { visibility: "public" }],
                ]),
              });
        }),
    });
    const resolver = mockBinaryResolver();
    const spawner = mockChildProcessSpawner();
    const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(resolver.layer));
    const config = {
      ...defaultConfig,
      postgrest: false,
      auth: false,
      servicePolicies: {
        ...defaultConfig.servicePolicies,
        postgrest: "off",
        auth: "off",
      },
    } satisfies ResolvedStackConfig;
    const layer = localStackLayer(config, noopPortLease(config.ports)).pipe(
      Layer.provide(builderLayer),
      Layer.provide(stackPreparationLayer),
      Layer.provide(spawner.layer),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      expect(Exit.isFailure(yield* stack.start.pipe(Effect.exit))).toBe(true);
      yield* stack.start;
      expect(buildAttempts).toBe(2);
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("rejects an all-eager graph that omits an enabled public service", () => {
    const graph = Effect.runSync(
      buildGraph([{ name: "postgres", command: "true", restart: "no" }]),
    );
    const builderLayer = Layer.succeed(StackBuilder, {
      build: () =>
        Effect.succeed({
          graph,
          cleanupTargets: { dockerContainerNames: [] },
          serviceProjection: new Map([["postgres", { visibility: "public" as const }]]),
        }),
    });
    const resolver = mockBinaryResolver();
    const layer = localStackLayer(defaultConfig, noopPortLease(defaultConfig.ports)).pipe(
      Layer.provide(builderLayer),
      Layer.provide(StackPreparation.layer.pipe(Layer.provide(resolver.layer))),
      Layer.provide(mockChildProcessSpawner().layer),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const exit = yield* stack.start.pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toMatchObject({
          _tag: "Some",
          value: {
            _tag: "StackBuildError",
            detail: "Prepared graph does not contain enabled service postgrest",
          },
        });
      }
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("can retry start after asset preparation fails before services start", () => {
    const resolver = mockBinaryResolver({
      failOnceServices: ["postgres"],
    });
    const config = {
      ...defaultConfig,
      postgrest: false,
      auth: false,
      servicePolicies: {
        ...defaultConfig.servicePolicies,
        postgrest: "off",
        auth: "off",
      },
    } satisfies ResolvedStackConfig;
    const { layer } = setupLayer(config, noopPortLease(config.ports), undefined, resolver);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      expect(Exit.isFailure(yield* stack.start.pipe(Effect.exit))).toBe(true);
      yield* stack.start;
      expect((yield* stack.getState("postgres")).status).toBe("Healthy");
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("restarts activated analytics companions across repeated stack cycles", () => {
    const graph = Effect.runSync(
      buildGraph([
        {
          name: "postgres",
          command: process.execPath,
          restart: "no",
          healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
        },
        {
          name: "postgrest",
          command: process.execPath,
          restart: "no",
          healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
        },
        {
          name: "pgmeta",
          command: process.execPath,
          restart: "no",
          healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
        },
        {
          name: "studio",
          command: process.execPath,
          restart: "no",
          healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
        },
        {
          name: "analytics",
          command: process.execPath,
          restart: "no",
          healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
        },
        {
          name: "vector",
          command: process.execPath,
          restart: "no",
          healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
        },
      ]),
    );
    const builderLayer = Layer.succeed(StackBuilder, {
      build: () =>
        Effect.succeed({
          graph,
          cleanupTargets: { dockerContainerNames: [] },
          serviceProjection: new Map([
            ["postgres", { visibility: "public" as const }],
            ["postgrest", { visibility: "public" as const }],
            ["pgmeta", { visibility: "public" as const }],
            ["studio", { visibility: "public" as const }],
            ["analytics", { visibility: "public" as const }],
            ["vector", { visibility: "public" as const }],
          ]),
        }),
    });
    const config = {
      ...defaultConfig,
      runtime: { mode: "docker", containerRuntime: "docker" },
      pgmeta: { port: defaultPorts.pgmetaPort, version: DEFAULT_VERSIONS.pgmeta },
      studio: {
        port: defaultPorts.studioPort,
        apiUrl: "http://127.0.0.1:54321",
        version: DEFAULT_VERSIONS.studio,
      },
      analytics: {
        port: defaultPorts.analyticsPort,
        version: DEFAULT_VERSIONS.analytics,
        backend: "postgres",
        apiKey: "test-api-key",
      },
      vector: { version: DEFAULT_VERSIONS.vector },
      servicePolicies: {
        ...defaultConfig.servicePolicies,
        auth: "off",
        postgrest: "lazy",
        pgmeta: "off",
        studio: "off",
        analytics: "lazy",
        vector: "lazy",
      },
      auth: false,
    } satisfies ResolvedStackConfig;
    const { resolver, spawner } = setupLayer(config, noopPortLease(config.ports));
    const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(resolver.layer));
    const layer = localStackLayer(config, noopPortLease(config.ports)).pipe(
      Layer.provide(builderLayer),
      Layer.provide(stackPreparationLayer),
      Layer.provide(spawner.layer),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const activator = yield* StackServiceActivator;
      yield* stack.start;
      yield* activator.activate("analytics");
      expect((yield* stack.getState("analytics")).status).toBe("Healthy");
      expect((yield* stack.getState("vector")).status).toBe("Healthy");
      yield* stack.stop;
      yield* stack.start;
      yield* stack.restartService("analytics");
      yield* activator.activate("analytics");
      expect((yield* stack.getState("analytics")).status).toBe("Healthy");
      expect((yield* stack.getState("vector")).status).toBe("Healthy");
      yield* stack.stop;
      yield* stack.start;
      yield* stack.stop;
      yield* stack.start;
      yield* activator.activate("analytics");

      expect((yield* stack.getState("analytics")).status).toBe("Healthy");
      expect((yield* stack.getState("vector")).status).toBe("Healthy");
    }).pipe(Effect.provide(layer), Effect.timeout("10 seconds"));
  });

  it.live("retains lazy companion allowances when an interrupted stack stop is retried", () =>
    Effect.gen(function* () {
      const cleanupStarted = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const graph = Effect.runSync(
        buildGraph([
          {
            name: "postgres",
            command: process.execPath,
            restart: "no",
            healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
          },
          {
            name: "analytics",
            command: process.execPath,
            restart: "no",
            healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
            cleanup: Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCleanup)),
            ),
          },
          {
            name: "vector",
            command: process.execPath,
            restart: "no",
            healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
          },
        ]),
      );
      const config = {
        ...defaultConfig,
        runtime: { mode: "docker", containerRuntime: "docker" },
        postgrest: false,
        auth: false,
        analytics: {
          port: defaultPorts.analyticsPort,
          version: DEFAULT_VERSIONS.analytics,
          backend: "postgres",
          apiKey: "test-api-key",
        },
        vector: { version: DEFAULT_VERSIONS.vector },
        servicePolicies: {
          ...defaultConfig.servicePolicies,
          auth: "off",
          postgrest: "off",
          analytics: "lazy",
          vector: "lazy",
        },
      } satisfies ResolvedStackConfig;
      const builderLayer = Layer.succeed(StackBuilder, {
        build: () =>
          Effect.succeed({
            graph,
            cleanupTargets: { dockerContainerNames: [] },
            serviceProjection: new Map([
              ["postgres", { visibility: "public" as const }],
              ["analytics", { visibility: "public" as const }],
              ["vector", { visibility: "public" as const }],
            ]),
          }),
      });
      const { resolver, spawner } = setupLayer(config, noopPortLease(config.ports));
      const layer = localStackLayer(config, noopPortLease(config.ports)).pipe(
        Layer.provide(builderLayer),
        Layer.provide(StackPreparation.layer.pipe(Layer.provide(resolver.layer))),
        Layer.provide(spawner.layer),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const activator = yield* StackServiceActivator;
        yield* stack.start;
        yield* activator.activate("analytics");

        const stopping = yield* (yield* stack.stateChanges("analytics")).pipe(
          Stream.filter((state) => state.status === "Stopping"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const stoppingStack = yield* stack.stop.pipe(Effect.forkChild({ startImmediately: true }));
        expect(Option.isSome(yield* Fiber.join(stopping))).toBe(true);
        yield* Deferred.await(cleanupStarted);

        const interrupting = yield* Fiber.interrupt(stoppingStack).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        // Immediate evaluation delivers the interruption before returning while
        // the interrupt effect waits for the gated cleanup to finish.
        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Fiber.join(interrupting);

        yield* stack.stop;
        yield* stack.start;
        yield* activator.activate("analytics");
        expect((yield* stack.getState("analytics")).status).toBe("Healthy");
        expect((yield* stack.getState("vector")).status).toBe("Healthy");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  );

  it.live("rejects a cached start when disposal begins during startup", () =>
    Effect.gen(function* () {
      const startEntered = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const config = {
        ...defaultConfig,
        postgrest: false,
        auth: false,
        servicePolicies: {
          ...defaultConfig.servicePolicies,
          postgrest: "off",
          auth: "off",
        },
      } satisfies ResolvedStackConfig;
      const graph = Effect.runSync(
        buildGraph([{ name: "postgres", command: "true", restart: "no" }]),
      );
      const builderLayer = Layer.succeed(StackBuilder, {
        build: () =>
          Effect.succeed({
            graph,
            cleanupTargets: { dockerContainerNames: [] },
            serviceProjection: new Map([["postgres", { visibility: "public" as const }]]),
          }),
      });
      let gateNextStart = false;
      const portLease: PortLease = {
        ports: config.ports,
        reserve: () => {
          if (!gateNextStart) return Effect.void;
          gateNextStart = false;
          return Deferred.succeed(startEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseStart)),
          );
        },
        release: () => Effect.void,
        releaseAll: Effect.void,
      };
      const resolver = mockBinaryResolver();
      const layer = localStackLayer(config, portLease).pipe(
        Layer.provide(builderLayer),
        Layer.provide(StackPreparation.layer.pipe(Layer.provide(resolver.layer))),
        Layer.provide(mockChildProcessSpawner().layer),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        yield* stack.start;
        yield* stack.stop;

        gateNextStart = true;
        const holder = yield* stack.start.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(startEntered);
        const disposing = yield* stack.dispose.pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.succeed(releaseStart, undefined);
        const holderExit = yield* Fiber.await(holder);
        expect(Exit.isFailure(holderExit)).toBe(true);
        if (Exit.isFailure(holderExit)) {
          expect(Cause.squash(holderExit.cause)).toMatchObject({ _tag: "StackBuildError" });
        }
        yield* Fiber.join(disposing);

        expect((yield* stack.getState("postgres")).status).toBe("Stopped");
        const afterDisposal = yield* stack.start.pipe(Effect.flip);
        expect(Predicate.isTagged(afterDisposal, "StackBuildError")).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live("a partial startup failure disposes resources from services already started", () => {
    let cleaned = false;
    const spawner = mockChildProcessSpawner({
      beforeSpawn: (record) =>
        record.command === "fail" ? Effect.die("simulated spawn failure") : Effect.void,
    });
    const graph = Effect.runSync(
      buildGraph([
        {
          name: "postgres",
          command: process.execPath,
          restart: "no",
          cleanup: Effect.sync(() => {
            cleaned = true;
          }),
        },
        {
          name: "postgrest",
          command: "fail",
          dependencies: [{ service: "postgres", condition: "started" }],
          restart: "no",
        },
      ]),
    );
    const builderLayer = Layer.succeed(StackBuilder, {
      build: () =>
        Effect.succeed({
          graph,
          cleanupTargets: { dockerContainerNames: [] },
          serviceProjection: new Map([
            ["postgres", { visibility: "public" }],
            ["postgrest", { visibility: "public" }],
          ]),
        }),
    });
    const resolver = mockBinaryResolver();
    const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(resolver.layer));
    const layer = localStackLayer(
      {
        ...defaultConfig,
        auth: false,
        servicePolicies: { ...defaultConfig.servicePolicies, auth: "off" },
        readiness: { mode: "finite", timeoutMs: 100 },
        readinessSource: "configured",
      },
      noopPortLease(defaultConfig.ports),
    ).pipe(
      Layer.provide(builderLayer),
      Layer.provide(stackPreparationLayer),
      Layer.provide(spawner.layer),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const exit = yield* stack.start.pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(cleaned).toBe(true);
      expect(spawner.killed).toContain("SIGTERM");
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("lazy startup starts direct services without starting HTTP backends", () => {
    const { layer } = setupLayer({
      ...defaultConfig,
      servicePolicies: {
        ...defaultConfig.servicePolicies,
        postgrest: "lazy",
        auth: "lazy",
        storage: "lazy",
        imgproxy: "lazy",
      },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start;
      yield* stack.waitAllReady();

      expect((yield* stack.getState("postgres")).status).toBe("Healthy");
      expect((yield* stack.getState("auth")).status).toBe("Dormant");
      expect((yield* stack.getState("postgrest")).status).toBe("Dormant");

      yield* stack.stop;
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("prepares a dormant service before restarting it", () =>
    Effect.gen(function* () {
      const resolver = mockBinaryResolver({ downloadedServices: ["postgrest"] });
      const config = {
        ...defaultConfig,
        servicePolicies: {
          ...defaultConfig.servicePolicies,
          postgrest: "lazy",
          auth: "lazy",
        },
      } satisfies ResolvedStackConfig;
      const { layer } = setupLayer(config, noopPortLease(config.ports), undefined, resolver);

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        yield* stack.start;
        const stateChanges = yield* stack.stateChanges("postgrest");
        const downloading = yield* stateChanges.pipe(
          Stream.filter((state) => state.status === "Downloading"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const running = yield* stateChanges.pipe(
          Stream.filter((state) => state.status === "Running"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const restarting = yield* stack
          .restartService("postgrest")
          .pipe(Effect.forkChild({ startImmediately: true }));

        expect(Option.isSome(yield* Fiber.join(downloading))).toBe(true);
        expect(Option.isSome(yield* Fiber.join(running))).toBe(true);

        yield* Fiber.interrupt(restarting);
        yield* stack.stop;
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live("does not restart a service after the stack stops during preparation", () =>
    Effect.gen(function* () {
      const allowPreparation = yield* Deferred.make<void>();
      const resolver = mockBinaryResolver({
        downloadedServices: ["postgrest"],
        beforeResolve: ({ service }) =>
          service === "postgrest" ? Deferred.await(allowPreparation) : Effect.void,
      });
      const config = {
        ...defaultConfig,
        servicePolicies: {
          ...defaultConfig.servicePolicies,
          postgrest: "lazy",
          auth: "lazy",
        },
      } satisfies ResolvedStackConfig;
      const { layer } = setupLayer(config, noopPortLease(config.ports), undefined, resolver);

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        yield* stack.start;
        const downloading = yield* (yield* stack.stateChanges("postgrest")).pipe(
          Stream.filter((state) => state.status === "Downloading"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const restarting = yield* stack
          .restartService("postgrest")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(downloading);
        const running = yield* (yield* stack.stateChanges("postgrest")).pipe(
          Stream.filter((state) => state.status === "Running"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* stack.stop;
        yield* Deferred.succeed(allowPreparation, undefined);
        const outcome = yield* Effect.race(
          Fiber.join(restarting).pipe(
            Effect.exit,
            Effect.map((exit) => ({ type: "restart" as const, exit })),
          ),
          Fiber.join(running).pipe(Effect.as({ type: "resurrected" as const })),
        );

        expect(outcome.type).toBe("restart");
        if (outcome.type === "restart") expect(Exit.isFailure(outcome.exit)).toBe(true);
        expect((yield* stack.getState("postgrest")).status).not.toBe("Running");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live("lazy activation restores dormant state after a stopped transitive dependency", () => {
    const config = {
      ...defaultConfig,
      servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
    } satisfies ResolvedStackConfig;
    const resolver = mockBinaryResolver({ downloadedServices: ["postgrest"] });
    const { layer } = setupLayer(config, noopPortLease(config.ports), undefined, resolver);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const activator = yield* StackServiceActivator;
      yield* stack.start;
      yield* stack.stopService("postgres");

      const downloading = yield* (yield* stack.stateChanges("postgrest")).pipe(
        Stream.filter((state) => state.status === "Downloading"),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      const error = yield* activator.activate("postgrest").pipe(Effect.flip);

      expect(Option.isSome(yield* Fiber.join(downloading))).toBe(true);
      expect(Predicate.isTagged(error, "StackBuildError")).toBe(true);
      if (Predicate.isTagged(error, "StackBuildError")) {
        expect(error.detail).toContain("postgres was explicitly stopped");
      }
      expect((yield* stack.getState("postgrest")).status).toBe("Dormant");
      yield* stack.stop;
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("preserves an explicit stop during in-flight lazy activation", () => {
    const config = {
      ...defaultConfig,
      servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
    } satisfies ResolvedStackConfig;
    const allowDownload = Deferred.makeUnsafe<void>();
    const resolver = mockBinaryResolver({
      downloadedServices: ["auth"],
      beforeResolve: ({ service }) =>
        service === "auth" ? Deferred.await(allowDownload) : Effect.void,
    });
    const { layer } = setupLayer(config, noopPortLease(config.ports), undefined, resolver);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const activator = yield* StackServiceActivator;
      yield* stack.start;

      const authChanges = yield* stack.stateChanges("auth");
      const downloading = yield* authChanges.pipe(
        Stream.filter((state) => state.status === "Downloading"),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      const stopped = yield* authChanges.pipe(
        Stream.filter((state) => state.status === "Stopped"),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      const activation = yield* activator
        .activate("auth")
        .pipe(Effect.forkChild({ startImmediately: true }));

      expect(Option.isSome(yield* Fiber.join(downloading))).toBe(true);
      yield* stack.stopService("auth");
      expect(Option.isSome(yield* Fiber.join(stopped))).toBe(true);
      yield* Deferred.succeed(allowDownload, undefined);

      const activationExit = yield* Fiber.await(activation);
      expect(Exit.isFailure(activationExit)).toBe(true);
      if (Exit.isFailure(activationExit)) {
        const error = Cause.squash(activationExit.cause);
        expect(error).toMatchObject({ _tag: "StackBuildError" });
        if (error instanceof StackBuildError) {
          expect(error.detail).toContain("auth was explicitly stopped");
        }
      }
      expect((yield* stack.getState("auth")).status).toBe("Stopped");
      yield* stack.stop;
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("rejects stopping a service before start without affecting a later start", () => {
    const config = {
      ...defaultConfig,
      servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
    } satisfies ResolvedStackConfig;
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const error = yield* stack.stopService("auth").pipe(Effect.flip);

      expect(Predicate.isTagged(error, "StackNotRunningError")).toBe(true);
      if (Predicate.isTagged(error, "StackNotRunningError")) expect(error.phase).toBe("idle");

      yield* stack.start;
      expect((yield* stack.getState("auth")).status).toBe("Dormant");
      yield* stack.stop;
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("lazy readiness includes an activation that is still starting", () =>
    Effect.gen(function* () {
      const spawnStarted = yield* Deferred.make<void>();
      const spawner = mockChildProcessSpawner({
        beforeSpawn: (record) =>
          record.args.some((arg) =>
            Buffer.from(arg, "base64url").toString().includes('"command":"/cache/auth/'),
          )
            ? Deferred.succeed(spawnStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const config = {
        ...defaultConfig,
        servicePolicies: {
          ...defaultConfig.servicePolicies,
          postgrest: "lazy",
          auth: "lazy",
          mailpit: "eager",
        },
      } satisfies ResolvedStackConfig;
      const { layer } = setupLayer(config, noopPortLease(config.ports), spawner);

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const activator = yield* StackServiceActivator;
        yield* stack.start;
        expect((yield* stack.getState("auth")).status).toBe("Dormant");
        const activeStateFiber = yield* stack.allStateChanges.pipe(
          Stream.filter((state) => state.name === "auth" && state.status !== "Dormant"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const activationFiber = yield* activator
          .activate("auth")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(spawnStarted);
        expect(Option.isSome(yield* Fiber.join(activeStateFiber))).toBe(true);
        expect((yield* stack.getState("auth")).status).not.toBe("Dormant");

        const readyFiber = yield* stack
          .waitAllReady()
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(readyFiber.pollUnsafe()).toBeUndefined();

        yield* stack.stop.pipe(Effect.timeout("1 second"));
        yield* Fiber.interrupt(readyFiber);
        yield* Fiber.interrupt(activationFiber);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live(
    "healthy activation stays available while a manual service start waits for readiness",
    () =>
      Effect.gen(function* () {
        const authSpawnStarted = yield* Deferred.make<void>();
        const spawner = mockChildProcessSpawner({
          beforeSpawn: (record) =>
            record.args.some((arg) =>
              Buffer.from(arg, "base64url").toString().includes('"command":"/cache/auth/'),
            )
              ? Deferred.succeed(authSpawnStarted, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
        });
        const config = {
          ...defaultConfig,
          servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
        } satisfies ResolvedStackConfig;
        const { layer } = setupLayer(config, noopPortLease(config.ports), spawner);

        yield* Effect.gen(function* () {
          const stack = yield* Stack;
          const activator = yield* StackServiceActivator;
          yield* stack.start;
          const manualStart = yield* stack
            .startService("auth")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(authSpawnStarted);

          yield* activator.activate("postgres");

          yield* Fiber.interrupt(manualStart);
          yield* stack.stop;
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live("begins independent eager services before waiting for their readiness", () =>
    Effect.gen(function* () {
      const postgresReleaseStarted = yield* Deferred.make<void>();
      const allowPostgresRelease = yield* Deferred.make<void>();
      const mailpitReleaseStarted = yield* Deferred.make<void>();
      const config = {
        ...defaultConfig,
        runtime: { mode: "docker", containerRuntime: "docker" },
        servicePolicies: {
          ...defaultConfig.servicePolicies,
          postgrest: "off",
          auth: "off",
          mailpit: "eager",
        },
        postgrest: false,
        auth: false,
        mailpit: {
          port: defaultPorts.mailpitPort,
          smtpPort: defaultPorts.mailpitSmtpPort,
          pop3Port: defaultPorts.mailpitPop3Port,
          version: DEFAULT_VERSIONS.mailpit,
          adminEmail: "admin@example.com",
          senderName: "Admin",
        },
      } satisfies ResolvedStackConfig;
      const lease: PortLease = {
        ports: config.ports,
        reserve: () => Effect.void,
        release: (fields) =>
          fields.includes("dbPort")
            ? Deferred.succeed(postgresReleaseStarted, undefined).pipe(
                Effect.andThen(Deferred.await(allowPostgresRelease)),
              )
            : fields.includes("mailpitPort")
              ? Deferred.succeed(mailpitReleaseStarted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        releaseAll: Effect.void,
      };
      const graph = Effect.runSync(
        buildGraph([
          {
            name: "postgres",
            command: process.execPath,
            restart: "unless-stopped",
            healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
          },
          {
            name: "mailpit",
            command: process.execPath,
            restart: "unless-stopped",
            healthCheck: { probe: { _tag: "Exec", command: "true", args: [] } },
          },
        ]),
      );
      const builderLayer = Layer.succeed(StackBuilder, {
        build: () =>
          Effect.succeed({
            graph,
            cleanupTargets: { dockerContainerNames: [] },
            serviceProjection: new Map([
              ["postgres", { visibility: "public" as const }],
              ["mailpit", { visibility: "public" as const }],
            ]),
          }),
      });
      const resolver = mockBinaryResolver();
      const layer = localStackLayer(config, lease).pipe(
        Layer.provide(builderLayer),
        Layer.provide(StackPreparation.layer.pipe(Layer.provide(resolver.layer))),
        Layer.provide(mockChildProcessSpawner().layer),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const starting = yield* stack.start.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(postgresReleaseStarted);

        yield* Deferred.await(mailpitReleaseStarted);
        yield* Deferred.succeed(allowPostgresRelease, undefined);
        yield* Fiber.join(starting);

        expect((yield* stack.getState("postgres")).status).toBe("Healthy");
        expect((yield* stack.getState("mailpit")).status).toBe("Healthy");

        yield* stack.stop;
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live("dispose cancels an in-flight lazy activation", () =>
    Effect.gen(function* () {
      const spawnStarted = yield* Deferred.make<void>();
      const allowSpawn = yield* Deferred.make<void>();
      const spawner = mockChildProcessSpawner({
        beforeSpawn: (record) =>
          record.args.some((arg) =>
            Buffer.from(arg, "base64url").toString().includes('"command":"/cache/auth/'),
          )
            ? Deferred.succeed(spawnStarted, undefined).pipe(
                Effect.andThen(Deferred.await(allowSpawn)),
              )
            : Effect.void,
      });
      const config = {
        ...defaultConfig,
        servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
      } satisfies ResolvedStackConfig;
      const { layer } = setupLayer(config, noopPortLease(config.ports), spawner);

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const activator = yield* StackServiceActivator;
        yield* stack.start;
        const activationFiber = yield* activator
          .activate("auth")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(spawnStarted);

        const disposeFiber = yield* stack.dispose.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.join(disposeFiber);
        yield* Deferred.succeed(allowSpawn, undefined);
        yield* Fiber.interrupt(activationFiber);

        expect(spawner.spawned.some((record) => record.command.endsWith("/auth"))).toBe(false);

        const error = yield* activator.activate("auth").pipe(Effect.flip);
        expect(Predicate.isTagged(error, "StackBuildError")).toBe(true);
        if (Predicate.isTagged(error, "StackBuildError")) {
          expect(error.detail).toContain("disposal has begun");
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live("dispose cancels in-flight lazy preparation", () =>
    Effect.gen(function* () {
      const preparationStarted = yield* Deferred.make<void>();
      const disposed = yield* Deferred.make<void>();
      const resolver = mockBinaryResolver({
        downloadedServices: ["auth"],
        beforeResolve: ({ service }) =>
          service === "auth"
            ? Deferred.succeed(preparationStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const config = {
        ...defaultConfig,
        servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
      } satisfies ResolvedStackConfig;
      const lease = {
        ...noopPortLease(config.ports),
        releaseAll: Deferred.succeed(disposed, undefined).pipe(Effect.asVoid),
      } satisfies PortLease;
      const { layer } = setupLayer(config, lease, mockChildProcessSpawner(), resolver);

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        yield* stack.start;
        const activation = yield* stack
          .startService("auth")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(preparationStarted);
        const secondActivation = yield* stack
          .startService("auth")
          .pipe(Effect.forkChild({ startImmediately: true }));

        const disposing = yield* stack.dispose.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(disposed);
        yield* Fiber.join(disposing);

        const activationExit = yield* Fiber.await(activation);
        const secondActivationExit = yield* Fiber.await(secondActivation);
        expect(Exit.isFailure(activationExit)).toBe(true);
        expect(Exit.isFailure(secondActivationExit)).toBe(true);
        if (Exit.isFailure(activationExit)) {
          expect(Cause.squash(activationExit.cause)).toMatchObject({
            _tag: "StackBuildError",
            detail: "Stack disposed during asset preparation",
          });
        }
        if (Exit.isFailure(secondActivationExit)) {
          expect(Cause.squash(secondActivationExit.cause)).toMatchObject({
            _tag: "StackBuildError",
            detail: "Stack disposed during asset preparation",
          });
        }
        expect((yield* stack.getState("auth")).status).not.toBe("Downloading");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.live("allows a finite wait override against an infinite stack policy", () =>
    Effect.gen(function* () {
      const spawnStarted = yield* Deferred.make<void>();
      const spawner = mockChildProcessSpawner({
        beforeSpawn: (record) =>
          record.command === "/cache/auth"
            ? Deferred.succeed(spawnStarted, undefined)
            : Effect.void,
      });
      let releasedAll = false;
      const config = {
        ...defaultConfig,
        postgrest: false,
        servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "off", auth: "lazy" },
        readiness: { mode: "infinite" },
        readinessSource: "configured",
      } satisfies ResolvedStackConfig;
      const graph = Effect.runSync(
        buildGraph([
          {
            name: "postgres",
            command: "true",
            restart: "no",
          },
          {
            name: "auth",
            command: "/cache/auth",
            dependencies: [{ service: "postgres", condition: "started" }],
            restart: "unless-stopped",
            healthCheck: {
              probe: {
                _tag: "Http",
                host: "127.0.0.1",
                port: 1,
                path: "/health",
                scheme: "http",
              },
              periodSeconds: 10,
            },
            hooks: [{ on: "started", run: (log) => log("stderr", "auth startup failed") }],
          },
        ]),
      );
      const builderLayer = Layer.succeed(StackBuilder, {
        build: () =>
          Effect.succeed({
            graph,
            cleanupTargets: { dockerContainerNames: [] },
            serviceProjection: new Map([
              ["postgres", { visibility: "public" as const }],
              ["auth", { visibility: "public" as const }],
            ]),
          }),
      });
      const lease: PortLease = {
        ...noopPortLease(config.ports),
        releaseAll: Effect.sync(() => {
          releasedAll = true;
        }),
      };
      const resolver = mockBinaryResolver();
      const layer = localStackLayer(config, lease).pipe(
        Layer.provide(builderLayer),
        Layer.provide(StackPreparation.layer.pipe(Layer.provide(resolver.layer))),
        Layer.provide(spawner.layer),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const activator = yield* StackServiceActivator;
        yield* stack.start;
        const authLog = yield* stack
          .subscribeLogs("auth")
          .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }));
        const activation = yield* activator
          .activate("auth")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(spawnStarted);
        const authLogEntry = yield* Fiber.join(authLog);
        expect(authLogEntry).toMatchObject({
          _tag: "Some",
          value: { line: "auth startup failed", service: "auth" },
        });

        const error = yield* stack
          .waitAllReady({ mode: "finite", timeoutMs: 25 })
          .pipe(Effect.flip);

        expect(Predicate.isTagged(error, "StackReadinessError")).toBe(true);
        if (Predicate.isTagged(error, "StackReadinessError")) {
          expect(error.target).toBe("stack");
          expect(error.timeoutMs).toBe(25);
          expect(error.detail).toContain("Non-ready services: auth:");
          expect(error.detail).toContain("Recent logs");
          expect(error.detail).toContain("auth startup failed");
        }
        expect(releasedAll).toBe(true);
        yield* Fiber.interrupt(activation);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live("does not revive stopped lazy dependents when restarting a dependency", () => {
    return Effect.gen(function* () {
      const authHealthServer = yield* Effect.acquireRelease(
        Effect.tryPromise(
          () =>
            new Promise<Server>((resolve, reject) => {
              const server = createServer((_request, response) => {
                response.writeHead(200, { "content-type": "text/plain" });
                response.end("ok");
              });
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) =>
          Effect.tryPromise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const address = authHealthServer.address();
      const authPort = typeof address === "object" && address !== null ? address.port : undefined;
      if (authPort === undefined) {
        throw new Error("Expected the auth health test server to bind a TCP port");
      }
      const authConfig = defaultConfig.auth;
      if (authConfig === false) {
        throw new Error("Expected auth to be enabled in the default test config");
      }
      const { layer, spawner } = setupLayer({
        ...defaultConfig,
        servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
        ports: { ...defaultPorts, authPort },
        auth: { ...authConfig, port: authPort },
      });
      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const activator = yield* StackServiceActivator;
        const isAuthStart = (record: { readonly args: ReadonlyArray<string> }) =>
          record.args.some((arg) =>
            Buffer.from(arg, "base64url").toString().includes('"command":"/cache/auth/'),
          );
        yield* stack.start;
        yield* activator.activate("auth");
        const initialAuthStarts = spawner.spawned.filter(isAuthStart).length;
        expect(initialAuthStarts).toBeGreaterThan(0);

        yield* stack.stopService("postgres");
        yield* stack.restartService("postgres");
        yield* stack.waitAllReady();

        expect(spawner.spawned.filter(isAuthStart)).toHaveLength(initialAuthStarts);
        expect((yield* stack.getState("auth")).status).toBe("Stopped");
        yield* stack.stop;
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds"));
  });

  it.live("lazy readiness fails fast before a service is activated", () => {
    const { layer } = setupLayer({
      ...defaultConfig,
      servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
    });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const beforeStart = yield* stack.waitAllReady().pipe(Effect.flip);
      expect(Predicate.isTagged(beforeStart, "StackBuildError")).toBe(true);

      yield* stack.start;
      const authNotActivated = yield* stack.waitReady("auth").pipe(Effect.flip);
      expect(Predicate.isTagged(authNotActivated, "ServiceReadyError")).toBe(true);

      yield* stack.stop;
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live(
    "restores dormant lazy services after preparation failure and retries successfully",
    () => {
      return Effect.gen(function* () {
        const healthServer = yield* Effect.acquireRelease(
          Effect.tryPromise(
            () =>
              new Promise<Server>((resolve, reject) => {
                const server = createServer((_request, response) => {
                  response.writeHead(200, { "content-type": "text/plain" });
                  response.end("ok");
                });
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.tryPromise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        const address = healthServer.address();
        const postgrestPort = typeof address === "object" && address !== null ? address.port : 0;
        if (postgrestPort === 0) throw new Error("Expected a PostgREST health port");
        const basePostgrest = defaultConfig.postgrest;
        if (basePostgrest === false) throw new Error("Expected PostgREST in the default config");
        const config = {
          ...defaultConfig,
          servicePolicies: {
            ...defaultConfig.servicePolicies,
            postgrest: "lazy",
            auth: "off",
          },
          auth: false,
          ports: {
            ...defaultConfig.ports,
            postgrestPort,
            postgrestAdminPort: postgrestPort + 1,
          },
          postgrest: {
            ...basePostgrest,
            port: postgrestPort,
            adminPort: postgrestPort + 1,
          },
        } satisfies ResolvedStackConfig;
        const failingResolver = mockBinaryResolver({ failOnceServices: ["postgrest"] });
        const stackPreparationLayer = StackPreparation.layer.pipe(
          Layer.provide(failingResolver.layer),
        );
        const testLayer = localStackLayer(config, noopPortLease(config.ports)).pipe(
          Layer.provide(StackBuilder.layer),
          Layer.provide(stackPreparationLayer),
          Layer.provide(mockChildProcessSpawner().layer),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const stack = yield* Stack;
          const activator = yield* StackServiceActivator;
          yield* stack.start;
          expect(["Running", "Healthy", "Initializing"]).toContain(
            (yield* stack.getState("postgres")).status,
          );
          expect((yield* stack.getState("postgrest")).status).toBe("Dormant");
          const first = yield* activator.activate("postgrest").pipe(Effect.flip);
          expect(Predicate.isTagged(first, "StackBuildError")).toBe(true);
          expect(["Running", "Healthy", "Initializing"]).toContain(
            (yield* stack.getState("postgres")).status,
          );
          expect((yield* stack.getState("postgrest")).status).toBe("Dormant");

          yield* activator.activate("postgrest");
          expect(["Running", "Healthy"]).toContain((yield* stack.getState("postgrest")).status);
          yield* stack.stop;
        }).pipe(Effect.provide(testLayer));
      }).pipe(Effect.scoped, Effect.timeout("5 seconds"));
    },
  );

  it.live("keeps unactivated services dormant after a stop and start cycle", () => {
    const config = {
      ...defaultConfig,
      servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
    } satisfies ResolvedStackConfig;
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start;
      expect((yield* stack.getState("auth")).status).toBe("Dormant");

      yield* stack.stop;
      yield* stack.start;

      expect((yield* stack.getState("auth")).status).toBe("Dormant");
      yield* stack.stop;
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("rejects a cached activation after the stack has stopped", () => {
    const config = {
      ...defaultConfig,
      servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
    } satisfies ResolvedStackConfig;
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const activator = yield* StackServiceActivator;
      yield* stack.start;
      yield* stack.stop;

      const error = yield* activator.activate("postgres").pipe(Effect.flip);
      expect(Predicate.isTagged(error, "StackNotRunningError")).toBe(true);
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("preserves an explicitly stopped service across a stack restart", () => {
    const config = {
      ...defaultConfig,
      servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
    } satisfies ResolvedStackConfig;
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start;
      // `stopService` settles the public projection before returning, so the
      // stopped state is observable immediately without stream coordination.
      yield* stack.stopService("auth");
      expect((yield* stack.getState("auth")).status).toBe("Stopped");

      yield* stack.stop;
      yield* stack.start;

      expect((yield* stack.getState("auth")).status).toBe("Stopped");
      yield* stack.stop;
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("releases only the ports in a lazy service dependency closure", () => {
    const released = new Set<PortField>();
    const authReleaseStarted = Deferred.makeUnsafe<void>();
    const lease: PortLease = {
      ports: defaultPorts,
      reserve: () => Effect.void,
      release: (fields) =>
        Effect.gen(function* () {
          for (const field of fields) {
            released.add(field);
            if (field === "authPort") yield* Deferred.succeed(authReleaseStarted, undefined);
          }
        }),
      releaseAll: Effect.void,
    };
    const { layer } = setupLayer(
      {
        ...defaultConfig,
        servicePolicies: { ...defaultConfig.servicePolicies, postgrest: "lazy", auth: "lazy" },
      },
      lease,
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start;

      expect(released.has("dbPort")).toBe(true);
      expect(released.has("authPort")).toBe(false);
      expect(released.has("postgrestPort")).toBe(false);

      const startFiber = yield* stack
        .startService("auth")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(authReleaseStarted);
      expect(released.has("authPort")).toBe(true);
      expect(released.has("postgrestPort")).toBe(false);

      yield* Fiber.interrupt(startFiber);
      yield* stack.stop;
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });
});
