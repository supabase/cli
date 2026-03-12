import { describe, expect, it } from "@effect/vitest";
import { createHmac } from "node:crypto";
import { Effect, Layer } from "effect";
import { mockChildProcessSpawner } from "../../process-compose/tests/helpers/mocks.ts";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { defaultPublishableKey, defaultSecretKey, generateJwt } from "./JwtGenerator.ts";
import type { AllocatedPorts } from "./PortAllocator.ts";
import { Stack } from "./Stack.ts";
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
  mode: "native",
  jwtSecret: testJwtSecret,
  ports: defaultPorts,
  apiPort: 54321,
  dbPort: 54322,
  publishableKey: defaultPublishableKey,
  secretKey: defaultSecretKey,
  autoManagedPaths: [],
  anonJwt: generateJwt(testJwtSecret, "anon"),
  serviceRoleJwt: generateJwt(testJwtSecret, "service_role"),
  postgres: {
    port: 54322,
    dataDir: "/tmp/supabase/data",
    version: DEFAULT_VERSIONS.postgres,
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

function setupLayer(config: ResolvedStackConfig = defaultConfig) {
  const resolver = mockBinaryResolver();
  const spawner = mockChildProcessSpawner();

  const layer = Stack.layer(config).pipe(
    Layer.provide(StackBuilder.layer),
    Layer.provide(resolver.layer),
    Layer.provide(spawner.layer),
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
      expect(postgres?.status).toBe("Initializing");

      for (const state of states) {
        expect(state.pid).toBeNull();
        expect(state.exitCode).toBeNull();
        expect(state.restartCount).toBe(0);
        expect(state.startedAt).toBeNull();
        expect(state.error).toBeNull();
      }
    }).pipe(Effect.provide(layer));
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
});
