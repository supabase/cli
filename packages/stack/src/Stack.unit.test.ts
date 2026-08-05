import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { createHmac } from "node:crypto";
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { mockChildProcessSpawner } from "../../process-compose/tests/helpers/mocks.ts";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { defaultPublishableKey, defaultSecretKey, generateJwt } from "./JwtGenerator.ts";
import type { AllocatedPorts, PortField, PortLease } from "./PortAllocator.ts";
import { StackServiceActivator } from "./ServiceActivation.ts";
import { Stack } from "./Stack.ts";
import { localStackLayer } from "./LocalStack.ts";
import { StackMetadataPersistence } from "./StackMetadataPersistence.ts";
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
  mode: "native",
  startupMode: "eager",
  readiness: DEFAULT_STACK_READINESS_POLICY,
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
  mode: "auto",
  edgeRuntime: {
    enabled: true,
    port: defaultPorts.edgeRuntimePort,
    inspectorPort: defaultPorts.edgeRuntimeInspectorPort,
    policy: "per_worker",
    version: DEFAULT_VERSIONS["edge-runtime"],
    env: {},
  },
};

const noopPortLease = (ports: AllocatedPorts): PortLease => ({
  ports,
  reserve: () => Effect.void,
  release: () => Effect.void,
  releaseAll: Effect.void,
});

function setupLayer(
  config: ResolvedStackConfig = defaultConfig,
  portLease: PortLease = noopPortLease(config.ports),
  spawner = mockChildProcessSpawner(),
) {
  const resolver = mockBinaryResolver();
  const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(resolver.layer));
  const layer = localStackLayer(config, portLease).pipe(
    Layer.provide(StackBuilder.layer),
    Layer.provide(stackPreparationLayer),
    Layer.provide(StackMetadataPersistence.noop),
    Layer.provide(spawner.layer),
    Layer.provide(BunServices.layer),
  );

  return { layer, resolver, spawner };
}

describe("Stack", () => {
  it.effect("getInfo returns correct URLs based on config", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const info = yield* stack.getInfo();

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
      const info = yield* stack.getInfo();

      expect(info.serviceEndpoints.functions).toBe("http://127.0.0.1:54321/functions/v1");
      expect(info.serviceEndpoints.edge_runtime).toBe("http://127.0.0.1:54321/functions/v1");
    }).pipe(Effect.provide(layer));
  });

  it.effect("getInfo returns valid JWT tokens", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const info = yield* stack.getInfo();

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
      const info = yield* stack.getInfo();

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
      const info1 = yield* stack.getInfo();
      const info2 = yield* stack.getInfo();

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
      const info = yield* stack.getInfo();

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
      const info = yield* stack.getInfo();

      expect(info.publishableKey).toBe("sb_publishable_custom_key");
      expect(info.secretKey).toBe("sb_secret_custom_key");
    }).pipe(Effect.provide(layer));
  });

  it.effect("getAllStates returns projected public states", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const states = yield* stack.getAllStates();

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
      const states = yield* stack.getAllStates();

      expect(states.map((state) => state.name)).toContain("edge-runtime");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits Downloading when a service fetches assets before startup", () => {
    const resolver = mockBinaryResolver({
      downloadedServices: ["postgres"],
      downloadDelayMs: 20,
    });
    const spawner = mockChildProcessSpawner();
    const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(resolver.layer));
    const layer = localStackLayer(defaultConfig, noopPortLease(defaultConfig.ports)).pipe(
      Layer.provide(StackBuilder.layer),
      Layer.provide(stackPreparationLayer),
      Layer.provide(StackMetadataPersistence.noop),
    );
    const providedLayer = layer.pipe(
      Layer.provide(spawner.layer),
      Layer.provide(BunServices.layer),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const statesFiber = yield* stack.allStateChanges().pipe(
        Stream.filter((state) => state.name === "postgres"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );

      const startFiber = yield* stack.start().pipe(Effect.forkChild({ startImmediately: true }));
      const states = yield* Fiber.join(statesFiber);
      yield* Fiber.interrupt(startFiber);

      expect(states.map((state) => state.status)).toContain("Downloading");
    }).pipe(Effect.provide(providedLayer));
  });

  it.effect("getState fails for internal helper services", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const exit = yield* stack.getState("postgres-init").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
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

  it.effect("startService fails with ServiceNotFoundError for unknown service", () => {
    const { layer } = setupLayer();

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const exit = yield* stack.startService("nonexistent").pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
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
      Layer.provide(StackMetadataPersistence.noop),
    );
    const providedLayer = layer.pipe(
      Layer.provide(spawner.layer),
      Layer.provide(BunServices.layer),
    );

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const exit = yield* stack.start().pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      // No container was ever started: only prepare-phase docker commands ran.
      const startedContainers = spawner.spawned.filter((record) => record.args[0] === "run");
      expect(startedContainers).toEqual([]);
    }).pipe(Effect.provide(providedLayer));
  });

  it.live("lazy startup starts direct services without starting HTTP backends", () => {
    const { layer, spawner } = setupLayer({ ...defaultConfig, startupMode: "lazy" });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start();
      yield* stack.waitAllReady();

      expect(
        spawner.spawned.some((record) =>
          record.args.some((arg) =>
            Buffer.from(arg, "base64url").toString().includes('"command":"bash"'),
          ),
        ),
      ).toBe(true);
      expect(spawner.spawned.some((record) => record.command.endsWith("/auth"))).toBe(false);
      expect(spawner.spawned.some((record) => record.command.endsWith("/postgrest"))).toBe(false);

      yield* stack.stop();
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("lazy activation honors explicitly stopped transitive dependencies", () => {
    const config: ResolvedStackConfig = {
      ...defaultConfig,
      mode: "auto",
      startupMode: "lazy",
      storage: {
        port: defaultPorts.storagePort,
        dataDir: "/tmp/supabase/storage",
        fileSizeLimit: "50MiB",
        s3ProtocolEnabled: true,
        version: DEFAULT_VERSIONS.storage,
      },
      imgproxy: {
        port: defaultPorts.imgproxyPort,
        version: DEFAULT_VERSIONS.imgproxy,
      },
    };
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const activator = yield* StackServiceActivator;
      yield* stack.start();
      yield* stack.stopService("imgproxy");

      const error = yield* activator.activate("storage").pipe(Effect.flip);

      expect(error._tag).toBe("StackBuildError");
      if (error._tag === "StackBuildError") {
        expect(error.detail).toContain("imgproxy was explicitly stopped");
      }
      yield* stack.stop();
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
      const config = { ...defaultConfig, startupMode: "lazy" } satisfies ResolvedStackConfig;
      const { layer } = setupLayer(config, noopPortLease(config.ports), spawner);

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const activator = yield* StackServiceActivator;
        yield* stack.start();
        expect((yield* stack.getState("auth")).status).toBe("Dormant");
        const activeStateFiber = yield* stack.allStateChanges().pipe(
          Stream.filter((state) => state.name === "auth" && state.status !== "Dormant"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        const activationFiber = yield* activator
          .activate("auth")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(spawnStarted);
        expect((yield* Fiber.join(activeStateFiber))._tag).toBe("Some");
        expect((yield* stack.getState("auth")).status).not.toBe("Dormant");

        const readyFiber = yield* stack
          .waitAllReady()
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(readyFiber.pollUnsafe()).toBeUndefined();

        yield* stack.stop().pipe(Effect.timeout("1 second"));
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
        const config = { ...defaultConfig, startupMode: "lazy" } satisfies ResolvedStackConfig;
        const { layer } = setupLayer(config, noopPortLease(config.ports), spawner);

        yield* Effect.gen(function* () {
          const stack = yield* Stack;
          const activator = yield* StackServiceActivator;
          yield* stack.start();
          const manualStart = yield* stack
            .startService("auth")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(authSpawnStarted);

          const activationCompleted = yield* Effect.race(
            activator.activate("postgres").pipe(Effect.as(true)),
            Effect.sleep("200 millis").pipe(Effect.as(false)),
          );

          yield* Fiber.interrupt(manualStart);
          expect(activationCompleted).toBe(true);
          yield* stack.stop();
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
        mode: "auto",
        startupMode: "lazy",
        mailpit: {
          port: defaultPorts.mailpitPort,
          smtpTransportPort: defaultPorts.mailpitSmtpPort,
          smtpHostPort: false,
          pop3HostPort: false,
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
      const { layer } = setupLayer(config, lease);

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const starting = yield* stack.start().pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(postgresReleaseStarted);

        const mailpitBeganConcurrently = yield* Effect.race(
          Deferred.await(mailpitReleaseStarted).pipe(Effect.as(true)),
          Effect.sleep("200 millis").pipe(Effect.as(false)),
        );
        yield* Deferred.succeed(allowPostgresRelease, undefined);
        yield* Fiber.interrupt(starting);

        expect(mailpitBeganConcurrently).toBe(true);
        yield* stack.stop();
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
      const config = { ...defaultConfig, startupMode: "lazy" } satisfies ResolvedStackConfig;
      const { layer } = setupLayer(config, noopPortLease(config.ports), spawner);

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const activator = yield* StackServiceActivator;
        yield* stack.start();
        const activationFiber = yield* activator
          .activate("auth")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(spawnStarted);

        const disposeFiber = yield* stack
          .dispose()
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(disposeFiber);
        yield* Deferred.succeed(allowSpawn, undefined);
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(activationFiber);

        expect(spawner.spawned.some((record) => record.command.endsWith("/auth"))).toBe(false);

        const error = yield* activator.activate("auth").pipe(Effect.flip);
        expect(error._tag).toBe("StackNotRunningError");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live("uses the stack readiness deadline for explicit lazy activation and cleans up", () =>
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
      let releasedAll = false;
      const config = {
        ...defaultConfig,
        startupMode: "lazy",
        readiness: { mode: "finite", timeoutMs: 250 },
      } satisfies ResolvedStackConfig;
      const lease: PortLease = {
        ...noopPortLease(config.ports),
        releaseAll: Effect.sync(() => {
          releasedAll = true;
        }),
      };
      const { layer } = setupLayer(config, lease, spawner);

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const activator = yield* StackServiceActivator;
        yield* stack.start();

        const error = yield* activator.activate("auth").pipe(Effect.flip);

        expect(error._tag).toBe("StackReadinessError");
        if (error._tag === "StackReadinessError") {
          expect(error.target).toBe("auth");
          expect(error.timeoutMs).toBe(250);
        }
        expect(releasedAll).toBe(true);
        const spawnCountAfterDisposal = spawner.spawned.length;
        expect((yield* activator.activate("postgres").pipe(Effect.flip))._tag).toBe(
          "StackNotRunningError",
        );
        for (const operation of [
          stack.start(),
          stack.startService("postgres"),
          stack.stopService("postgres"),
          stack.restartService("postgres"),
          stack.reloadFunctions(),
          stack.reloadEdgeRuntime({ edgeRuntime: {} }),
        ]) {
          expect((yield* operation.pipe(Effect.flip))._tag).toBe("StackBuildError");
        }
        yield* stack.stop();
        expect(spawner.spawned).toHaveLength(spawnCountAfterDisposal);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live("allows a finite wait override against an infinite stack policy", () =>
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
      let releasedAll = false;
      const config = {
        ...defaultConfig,
        startupMode: "lazy",
        readiness: { mode: "infinite" },
      } satisfies ResolvedStackConfig;
      const lease: PortLease = {
        ...noopPortLease(config.ports),
        releaseAll: Effect.sync(() => {
          releasedAll = true;
        }),
      };
      const { layer } = setupLayer(config, lease, spawner);

      yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const activator = yield* StackServiceActivator;
        yield* stack.start();
        const activation = yield* activator
          .activate("auth")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(spawnStarted);

        const error = yield* stack
          .waitAllReady({ mode: "finite", timeoutMs: 25 })
          .pipe(Effect.flip);

        expect(error._tag).toBe("StackReadinessError");
        if (error._tag === "StackReadinessError") {
          expect(error.target).toBe("stack");
          expect(error.timeoutMs).toBe(25);
        }
        expect(releasedAll).toBe(true);
        yield* Fiber.interrupt(activation);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
  );

  it.live("does not revive stopped lazy dependents when restarting a dependency", () => {
    return Effect.gen(function* () {
      const authHealthServer = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch: () => new Response("ok"),
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      );
      const authPort = authHealthServer.port;
      if (authPort === undefined) {
        throw new Error("Expected the auth health test server to bind a TCP port");
      }
      const authConfig = defaultConfig.auth;
      if (authConfig === false) {
        throw new Error("Expected auth to be enabled in the default test config");
      }
      const { layer, spawner } = setupLayer({
        ...defaultConfig,
        startupMode: "lazy",
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
        yield* stack.start();
        yield* activator.activate("auth");
        const initialAuthStarts = spawner.spawned.filter(isAuthStart).length;
        expect(initialAuthStarts).toBeGreaterThan(0);

        yield* stack.stopService("postgres");
        yield* stack.restartService("postgres");
        yield* stack.waitAllReady();

        expect(spawner.spawned.filter(isAuthStart)).toHaveLength(initialAuthStarts);
        expect((yield* stack.getState("auth")).status).toBe("Stopped");
        yield* stack.stop();
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.timeout("5 seconds"));
  });

  it.live("lazy readiness fails fast before a service is activated", () => {
    const { layer } = setupLayer({ ...defaultConfig, startupMode: "lazy" });

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const beforeStart = yield* stack.waitAllReady().pipe(Effect.flip);
      expect(beforeStart._tag).toBe("StackBuildError");

      yield* stack.start();
      const authNotActivated = yield* stack.waitReady("auth").pipe(Effect.flip);
      expect(authNotActivated._tag).toBe("ServiceReadyError");

      yield* stack.stop();
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("keeps unactivated services dormant after a stop and start cycle", () => {
    const config = { ...defaultConfig, startupMode: "lazy" } satisfies ResolvedStackConfig;
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start();
      expect((yield* stack.getState("auth")).status).toBe("Dormant");

      yield* stack.stop();
      yield* stack.start();

      expect((yield* stack.getState("auth")).status).toBe("Dormant");
      yield* stack.stop();
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("rejects a cached activation after the stack has stopped", () => {
    const config = { ...defaultConfig, startupMode: "lazy" } satisfies ResolvedStackConfig;
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      const activator = yield* StackServiceActivator;
      yield* stack.start();
      yield* stack.stop();

      const error = yield* activator.activate("postgres").pipe(Effect.flip);
      expect(error._tag).toBe("StackNotRunningError");
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("preserves an explicitly stopped service across a stack restart", () => {
    const config = { ...defaultConfig, startupMode: "lazy" } satisfies ResolvedStackConfig;
    const { layer } = setupLayer(config);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start();
      yield* stack.stopService("auth");
      yield* Effect.sleep("20 millis");
      expect((yield* stack.getState("auth")).status).toBe("Stopped");

      yield* stack.stop();
      yield* stack.start();

      expect((yield* stack.getState("auth")).status).toBe("Stopped");
      yield* stack.stop();
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });

  it.live("releases only the ports in a lazy service dependency closure", () => {
    const released = new Set<PortField>();
    const lease: PortLease = {
      ports: defaultPorts,
      reserve: () => Effect.void,
      release: (fields) =>
        Effect.sync(() => {
          for (const field of fields) released.add(field);
        }),
      releaseAll: Effect.void,
    };
    const { layer } = setupLayer({ ...defaultConfig, startupMode: "lazy" }, lease);

    return Effect.gen(function* () {
      const stack = yield* Stack;
      yield* stack.start();

      expect(released.has("dbPort")).toBe(true);
      expect(released.has("authPort")).toBe(false);
      expect(released.has("postgrestPort")).toBe(false);

      const startFiber = yield* stack
        .startService("auth")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.sleep("50 millis");
      expect(released.has("authPort")).toBe(true);
      expect(released.has("postgrestPort")).toBe(false);

      yield* Fiber.interrupt(startFiber);
      yield* stack.stop();
    }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));
  });
});
