import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { compileStack } from "./Compiler.ts";
import {
  resolveNativeArtifactForWorkload,
  targetForPlatform,
  WORKLOAD_CATALOG,
} from "./WorkloadCatalog.ts";
import { StackPreparationError } from "../public/Errors.ts";

const compile = (config: Parameters<typeof compileStack>[0]["config"]) =>
  compileStack({ projectRoot: "/tmp/catalog-project", runtime: { kind: "native" }, config }).pipe(
    Effect.provide(NodeServices.layer),
  );

describe("complete workload catalog", () => {
  it("matches the executable paths shipped by slim-services archives", () => {
    const expected = {
      "database:database": "share/supabase-cli/bin/supabase-postgres-init.sh",
      "rest:rest": "bin/postgrest",
      "auth:auth": "bin/auth",
      "realtime:realtime": "bin/server",
      "storage:storage": "app/dist/start/server.js",
      "storage:imgproxy": "bin/imgproxy",
      "functions:edge-runtime": "bin/.edge-runtime-wrapped",
      "studio:studio": "app/apps/studio/server.js",
      "studio:pgmeta": "app/dist/server/server.js",
      "mail:mail": "bin/mailpit",
      "analytics:analytics": "bin/logflare",
      "analytics:vector": "bin/vector",
      "pooler:pooler": "bin/server",
    } as const;
    for (const [id, executable] of Object.entries(expected)) {
      expect(WORKLOAD_CATALOG[id]?.executablePath).toBe(executable);
      expect(WORKLOAD_CATALOG[id]?.requiredRuntimePaths).toContain(executable);
    }
    expect(WORKLOAD_CATALOG["realtime:realtime"]?.requiredRuntimePaths).toEqual([
      "bin/migrate",
      "bin/realtime",
      "bin/server",
    ]);
    expect(WORKLOAD_CATALOG["database:database"]?.requiredRuntimePaths).toContain(
      "share/supabase-cli/init-scripts",
    );
    expect(WORKLOAD_CATALOG["analytics:analytics"]?.requiredRuntimePaths).toEqual(["bin/logflare"]);
    expect(WORKLOAD_CATALOG["analytics:vector"]?.requiredRuntimePaths).toEqual([
      "bin/vector",
      "share/doc/vector/config/vector.yaml",
    ]);
    expect(WORKLOAD_CATALOG["pooler:pooler"]?.requiredRuntimePaths).toEqual([
      "bin/migrate",
      "bin/supavisor",
      "bin/server",
    ]);
    expect(Object.values(WORKLOAD_CATALOG).map((entry) => entry.containerAlias)).toEqual(
      expect.arrayContaining([
        "supabase-database",
        "supabase-rest",
        "supabase-auth",
        "supabase-realtime",
        "supabase-storage",
        "supabase-imgproxy",
        "supabase-functions",
        "supabase-studio",
        "supabase-pgmeta",
        "supabase-mail",
        "supabase-analytics",
        "supabase-vector",
        "supabase-pooler",
      ]),
    );
    expect(WORKLOAD_CATALOG["storage:storage"]?.nativeProcess).toEqual({
      executablePath: "node/bin/node",
      args: ["app/dist/start/server.js"],
      cwd: "app",
    });
    expect(WORKLOAD_CATALOG["studio:pgmeta"]?.nativeProcess).toEqual({
      executablePath: "node/bin/node",
      args: ["app/dist/server/server.js"],
      cwd: "app",
    });
    expect(WORKLOAD_CATALOG["studio:studio"]?.nativeProcess).toEqual({
      executablePath: "node/bin/node",
      args: ["app/apps/studio/docker-entrypoint.mjs"],
      cwd: "app",
    });
  });

  it.live("resolves every declared workload to a slim-services native release", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: {
          storage: { settings: { image_transformation: { enabled: true } } },
          analytics: { settings: { vector_port: 9001 } },
        },
      });
      expect(result.executionPlan.workloads.length).toBeGreaterThan(10);
      for (const workload of result.executionPlan.workloads) {
        const artifact = yield* resolveNativeArtifactForWorkload(workload);
        expect(artifact.provider).toBe("supabase/slim-services");
        expect(artifact.downloadUrl).toContain(
          "github.com/supabase/slim-services/releases/download",
        );
        expect(artifact.requiredRuntimePaths.length).toBeGreaterThan(0);
        expect(artifact.executablePath).toBeDefined();
      }
    }),
  );

  it.live("materialized settings control optional companion workloads", () =>
    Effect.gen(function* () {
      const defaults = yield* compile({});
      expect(defaults.executionPlan.workloads.some(({ id }) => id === "storage:imgproxy")).toBe(
        false,
      );
      expect(defaults.executionPlan.workloads.some(({ id }) => id === "analytics:vector")).toBe(
        false,
      );

      const enabled = yield* compile({
        capabilities: {
          storage: { settings: { image_transformation: { enabled: true } } },
          analytics: { settings: { vector_port: 9001 } },
        },
      });
      expect(enabled.executionPlan.workloads.some(({ id }) => id === "storage:imgproxy")).toBe(
        true,
      );
      expect(enabled.executionPlan.workloads.some(({ id }) => id === "analytics:vector")).toBe(
        true,
      );
    }),
  );

  it.live("derives native database artifacts from the planned release", () =>
    Effect.gen(function* () {
      const compiled = yield* compile({ capabilities: { database: { version: "14" } } });
      const database = compiled.executionPlan.workloads.find(
        ({ id }) => id === "database:database",
      );
      expect(database).toBeDefined();
      if (database === undefined) return;
      const artifact = yield* resolveNativeArtifactForWorkload(database, {
        os: "linux",
        arch: "x64",
      });
      expect(artifact.version).toBe("14.1.0.89");
      expect(artifact.downloadUrl).toContain("postgres-14.1.0.89-linux-amd64.tar.zst");
    }),
  );

  it.live("rejects an exact native release absent from the catalog", () =>
    Effect.gen(function* () {
      const compiled = yield* compile({});
      const database = compiled.executionPlan.workloads.find(
        ({ id }) => id === "database:database",
      );
      expect(database).toBeDefined();
      if (database === undefined) return;
      const unsupported = {
        ...database,
        artifacts: {
          ...database.artifacts,
          native: { ...database.artifacts.native, release: "99.0.0" },
        },
      };
      const failed = yield* resolveNativeArtifactForWorkload(unsupported, {
        os: "linux",
        arch: "x64",
      }).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(failed.cause));
        expect(error).toBeInstanceOf(StackPreparationError);
      }
    }),
  );

  it.live("rejects unsupported native targets before selecting an artifact", () => {
    expect(targetForPlatform({ os: "win32", arch: "x64" })).toBeUndefined();
    expect(targetForPlatform({ os: "darwin", arch: "x64" })).toBeUndefined();
    return Effect.gen(function* () {
      const compiled = yield* compile({});
      const database = compiled.executionPlan.workloads.find(
        ({ id }) => id === "database:database",
      );
      expect(database).toBeDefined();
      if (database === undefined) return;
      const failed = yield* resolveNativeArtifactForWorkload(database, {
        os: "win32",
        arch: "x64",
      }).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(failed.cause));
        expect(error).toBeInstanceOf(StackPreparationError);
      }
    });
  });
});
