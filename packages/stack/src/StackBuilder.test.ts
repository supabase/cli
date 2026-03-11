import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { defaultPublishableKey, defaultSecretKey, generateJwt } from "./JwtGenerator.ts";
import { StackBuilder } from "./StackBuilder.ts";
import type { ResolvedStackConfig } from "./StackBuilder.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const testJwtSecret = "super-secret-jwt-token-with-at-least-32-characters";

const baseConfig: ResolvedStackConfig = {
  home: "/tmp/supabase-test",
  mode: "auto",
  jwtSecret: testJwtSecret,
  apiPort: 3000,
  dbPort: 5432,
  publishableKey: defaultPublishableKey,
  secretKey: defaultSecretKey,
  autoManagedDataDir: false,
  anonJwt: generateJwt(testJwtSecret, "anon"),
  serviceRoleJwt: generateJwt(testJwtSecret, "service_role"),
  postgres: {
    port: 5432,
    dataDir: "/tmp/pg-data",
    version: DEFAULT_VERSIONS.postgres,
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
};

const dockerConfig: ResolvedStackConfig = {
  ...baseConfig,
  mode: "docker",
};

describe("StackBuilder", () => {
  it.effect("builds graph with all native binaries", () => {
    const resolver = mockBinaryResolver();
    const layer = Layer.provide(StackBuilder.layer, resolver.layer);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const { graph, dockerContainerNames } = yield* builder.build(baseConfig);

      expect(graph.startOrder.length).toBe(4);
      expect(dockerContainerNames).toEqual([]);

      const names = graph.startOrder.map((s) => s.name);
      expect(names).toContain("postgres");
      expect(names).toContain("postgres-init");
      expect(names).toContain("postgrest");
      expect(names).toContain("auth");

      // Ordering: postgres → postgres-init → [postgrest, auth]
      expect(names.indexOf("postgres")).toBeLessThan(names.indexOf("postgres-init"));
      expect(names.indexOf("postgres-init")).toBeLessThan(names.indexOf("postgrest"));
      expect(names.indexOf("postgres-init")).toBeLessThan(names.indexOf("auth"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses docker fallback when auth binary not found", () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    const layer = Layer.provide(StackBuilder.layer, resolver.layer);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const { graph } = yield* builder.build(baseConfig);

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
    const layer = Layer.provide(StackBuilder.layer, resolver.layer);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const { graph } = yield* builder.build(baseConfig);

      // No postgres-init when postgres falls back to Docker (3 services after
      // removing auth-migrate from the graph)
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
    const layer = Layer.provide(StackBuilder.layer, resolver.layer);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const { graph } = yield* builder.build(baseConfig);

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
    const layer = Layer.provide(StackBuilder.layer, resolver.layer);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const { graph } = yield* builder.build({ ...baseConfig, auth: false });

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
    const layer = Layer.provide(StackBuilder.layer, resolver.layer);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const { graph, dockerContainerNames } = yield* builder.build(dockerConfig);

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
      expect(dockerContainerNames).toEqual([
        `supa-postgres-${dockerConfig.apiPort}`,
        `supa-postgrest-${dockerConfig.apiPort}`,
        `supa-auth-${dockerConfig.apiPort}`,
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("docker mode wires auth directly to postgres readiness", () => {
    const resolver = mockBinaryResolver();
    const layer = Layer.provide(StackBuilder.layer, resolver.layer);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const { graph } = yield* builder.build(dockerConfig);

      const authDef = graph.startOrder.find((s) => s.name === "auth");
      expect(authDef?.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("docker mode has no postgres-init service for Docker postgres", () => {
    const resolver = mockBinaryResolver();
    const layer = Layer.provide(StackBuilder.layer, resolver.layer);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const { graph } = yield* builder.build(dockerConfig);

      const names = graph.startOrder.map((s) => s.name);
      expect(names).not.toContain("postgres-init");
    }).pipe(Effect.provide(layer));
  });

  it.effect("docker mode wires dependencies correctly", () => {
    const resolver = mockBinaryResolver();
    const layer = Layer.provide(StackBuilder.layer, resolver.layer);

    return Effect.gen(function* () {
      const builder = yield* StackBuilder;
      const { graph } = yield* builder.build(dockerConfig);

      const authDef = graph.startOrder.find((s) => s.name === "auth");
      expect(authDef?.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);

      // postgrest depends on postgres(healthy) — no postgres-init in Docker mode
      const postgrestDef = graph.startOrder.find((s) => s.name === "postgrest");
      expect(postgrestDef?.dependencies).toEqual([{ service: "postgres", condition: "healthy" }]);
    }).pipe(Effect.provide(layer));
  });
});
