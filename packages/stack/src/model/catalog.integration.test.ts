import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Path } from "effect";
import { compileStack, seedServiceRegistry, createExecutionPlan } from "./Compiler.ts";
import { CAPABILITY_NAMES } from "../public/Capability.ts";
import { workload } from "./CapabilityModule.ts";
import {
  catalogEntryFor,
  catalogReleaseFor,
  resolveNativeArtifactForWorkload,
  targetForPlatform,
  WORKLOAD_CATALOG,
} from "./WorkloadCatalog.ts";
import { StackPreparationError } from "../public/Errors.ts";

const databaseCatalog = catalogEntryFor("database:database");
const defaultDatabaseMajor = databaseCatalog.defaultVersion.split(".")[0];

const compile = (
  config: Parameters<typeof compileStack>[0]["config"],
  runtime: Parameters<typeof compileStack>[0]["runtime"] = { kind: "native" },
) =>
  Effect.gen(function* () {
    const context = { projectRoot: "/tmp/catalog-project", runtime, path: yield* Path.Path };
    const compiled = yield* compileStack({ ...context, config });
    const seeded = yield* seedServiceRegistry(
      compiled.definition,
      context,
      config ?? {},
      compiled.secrets,
    );
    const executionPlan = yield* createExecutionPlan(runtime, seeded.registry);
    return { ...compiled, registry: seeded.registry, executionPlan };
  }).pipe(Effect.provide(NodeServices.layer));

const compileContainer = (config: Parameters<typeof compileStack>[0]["config"]) =>
  compile(config, { kind: "container", engine: "docker" });

const expectWorkload = <T>(value: T | undefined, description: string): T => {
  expect(value, description).toBeDefined();
  if (value === undefined) throw new Error(`Expected ${description}`);
  return value;
};

describe("complete workload catalog", () => {
  it("uses the catalog release for both runtime artifact identities", () => {
    const selected = workload("rest", "rest");
    const catalog = catalogReleaseFor("rest:rest");
    expect(selected.artifacts).toEqual({
      native: { kind: "native", release: catalog?.version },
      container: { kind: "container", image: catalog?.containerImage },
    });
  });

  it("matches the executable paths shipped by slim-services archives", () => {
    const expected = {
      "database:database": "bin/supabase-postgres-start",
      "rest:rest": "bin/postgrest",
      "auth:auth": "bin/auth",
      "realtime:realtime": "bin/server",
      "storage:storage": "bin/storage",
      "storage:imgproxy": "bin/imgproxy",
      "functions:edge-runtime": "bin/edge-runtime",
      "studio:studio": "bin/studio",
      "studio:pgmeta": "bin/pgmeta",
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
      "bin/server",
      "bin/prepare",
    ]);
    expect(WORKLOAD_CATALOG["database:database"]?.requiredRuntimePaths).toEqual([
      "bin/supabase-postgres-start",
      "bin/pg_dump",
      "bin/pg_dumpall",
      "bin/psql",
    ]);
    expect(WORKLOAD_CATALOG["storage:storage"]?.requiredRuntimePaths).toEqual([
      "bin/storage",
      "bin/prepare",
    ]);
    expect(WORKLOAD_CATALOG["analytics:analytics"]?.requiredRuntimePaths).toEqual([
      "bin/logflare",
      "bin/prepare",
    ]);
    expect(WORKLOAD_CATALOG["analytics:vector"]?.requiredRuntimePaths).toEqual([
      "bin/vector",
      "share/doc/vector/config/vector.yaml",
    ]);
    expect(WORKLOAD_CATALOG["pooler:pooler"]?.requiredRuntimePaths).toEqual([
      "bin/server",
      "bin/prepare",
      "bin/provision-tenant",
    ]);
  });

  it.live("keeps persisted capability versions aligned with catalog releases", () =>
    Effect.gen(function* () {
      const defaults = yield* compile({});
      for (const name of CAPABILITY_NAMES) {
        const capability = defaults.definition.capabilities[name];
        if (!capability.enabled) continue;
        const workload =
          defaults.executionPlan.workloads.find((entry) => entry.recipeId === `${name}:${name}`) ??
          defaults.executionPlan.workloads.find((entry) => entry.capability === name);
        const selected = expectWorkload(workload, `${name} workload`);
        expect(selected.artifacts.native.release).toBe(capability.version);
      }

      const databaseAlias = yield* compile({
        capabilities: { database: { version: defaultDatabaseMajor } },
      });
      const database = databaseAlias.executionPlan.workloads.find(
        (entry) => entry.recipeId === "database:database",
      );
      const selected = expectWorkload(database, "database workload");
      expect(databaseAlias.definition.capabilities.database.version).toBe(
        selected.artifacts.native.release,
      );
      expect(selected.artifacts.native.release).toBe(databaseCatalog.defaultVersion);
    }),
  );

  it.live("resolves every declared workload to a slim-services native release", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: {
          storage: { settings: { image_transformation: { enabled: true } } },
          analytics: { settings: {} },
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

  it.live("uses canonical native release tags for companion workloads", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: {
          storage: { settings: { image_transformation: { enabled: true } } },
          analytics: { settings: {} },
        },
      });
      for (const id of ["studio:pgmeta", "analytics:vector"] as const) {
        const catalog = WORKLOAD_CATALOG[id];
        const selectedCatalog = expectWorkload(catalog, `${id} catalog entry`);
        const workload = result.executionPlan.workloads.find((entry) => entry.recipeId === id);
        const selectedWorkload = expectWorkload(workload, `${id} workload`);
        expect(selectedWorkload.artifacts.native.release).toBe(selectedCatalog.defaultVersion);
        const artifact = yield* resolveNativeArtifactForWorkload(selectedWorkload, {
          os: "darwin",
          arch: "arm64",
        });
        expect(artifact.releaseTag).toBe(
          `${selectedCatalog.service}-${selectedCatalog.defaultVersion}`,
        );
        expect(artifact.downloadUrl).toBe(
          `https://github.com/supabase/slim-services/releases/download/${selectedCatalog.service}-${selectedCatalog.defaultVersion}/${selectedCatalog.service}-${selectedCatalog.defaultVersion}-darwin-arm64.tar.zst`,
        );
      }
    }),
  );

  it.live("enables companion workloads by default and honors explicit disablement", () =>
    Effect.gen(function* () {
      const defaults = yield* compile({});
      expect(
        defaults.executionPlan.workloads.some(({ recipeId }) => recipeId === "storage:imgproxy"),
      ).toBe(true);
      expect(
        defaults.executionPlan.workloads.some(({ recipeId }) => recipeId === "analytics:vector"),
      ).toBe(true);
      expect(
        defaults.executionPlan.workloads.map((entry) => ({
          recipeId: entry.recipeId,
          dependencies: entry.dependencies.map(
            (id) =>
              expectWorkload(
                defaults.executionPlan.workloads.find((dependency) => dependency.id === id),
                "workload dependency",
              ).recipeId,
          ),
        })),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            recipeId: "storage:storage",
            dependencies: ["database:database", "storage:imgproxy"],
          }),
        ]),
      );

      const enabled = yield* compile({
        capabilities: {
          storage: { settings: { image_transformation: { enabled: true } } },
          analytics: { settings: {} },
        },
      });
      expect(
        enabled.executionPlan.workloads.some(({ recipeId }) => recipeId === "storage:imgproxy"),
      ).toBe(true);
      expect(
        enabled.executionPlan.workloads.some(({ recipeId }) => recipeId === "analytics:vector"),
      ).toBe(true);
      expect(
        enabled.executionPlan.workloads.map((entry) => ({
          recipeId: entry.recipeId,
          dependencies: entry.dependencies.map(
            (id) =>
              expectWorkload(
                enabled.executionPlan.workloads.find((dependency) => dependency.id === id),
                "workload dependency",
              ).recipeId,
          ),
        })),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            recipeId: "storage:storage",
            dependencies: ["database:database", "storage:imgproxy"],
          }),
          expect.objectContaining({ recipeId: "storage:imgproxy", dependencies: [] }),
          expect.objectContaining({
            recipeId: "analytics:analytics",
            dependencies: ["database:database"],
          }),
          expect.objectContaining({
            recipeId: "analytics:vector",
            dependencies: ["analytics:analytics"],
          }),
        ]),
      );

      const disabled = yield* compile({
        capabilities: {
          storage: { settings: { image_transformation: { enabled: false } } },
          analytics: { enabled: false },
          studio: { enabled: false },
        },
      });
      expect(
        disabled.executionPlan.workloads.some(({ recipeId }) => recipeId === "storage:imgproxy"),
      ).toBe(false);
      expect(
        disabled.executionPlan.workloads.some(({ recipeId }) => recipeId === "analytics:vector"),
      ).toBe(false);
    }),
  );

  it.live("selects qualified slim mirror images in container plans", () =>
    Effect.gen(function* () {
      const result = yield* compileContainer({
        capabilities: {
          storage: { settings: { image_transformation: { enabled: true } } },
          analytics: { settings: {} },
        },
      });
      const images = new Map(
        result.executionPlan.workloads.map((entry) => [
          entry.recipeId,
          entry.artifacts.container.image,
        ]),
      );
      expect(images.get("mail:mail")).toBe(catalogReleaseFor("mail:mail")?.containerImage);
      expect(images.get("storage:imgproxy")).toBe(
        catalogReleaseFor("storage:imgproxy")?.containerImage,
      );
      expect(images.get("analytics:vector")).toBe(
        catalogReleaseFor("analytics:vector")?.containerImage,
      );
    }),
  );

  it.live("derives native database artifacts from the planned release", () =>
    Effect.gen(function* () {
      const compiled = yield* compile({
        capabilities: { database: { version: defaultDatabaseMajor } },
      });
      const database = compiled.executionPlan.workloads.find(
        ({ recipeId }) => recipeId === "database:database",
      );
      const artifact = yield* resolveNativeArtifactForWorkload(
        expectWorkload(database, "database workload"),
        {
          os: "linux",
          arch: "x64",
        },
      );
      expect(artifact.version).toBe(databaseCatalog.defaultVersion);
      expect(artifact.downloadUrl).toContain(
        `postgres-${databaseCatalog.defaultVersion}-linux-amd64.tar.zst`,
      );
    }),
  );

  it.live("rejects an exact native release absent from the catalog", () =>
    Effect.gen(function* () {
      const compiled = yield* compile({});
      const database = compiled.executionPlan.workloads.find(
        ({ recipeId }) => recipeId === "database:database",
      );
      const selected = expectWorkload(database, "database workload");
      const unsupported = {
        ...selected,
        artifacts: {
          ...selected.artifacts,
          native: { ...selected.artifacts.native, release: "99.0.0" },
        },
      };
      const failed = yield* resolveNativeArtifactForWorkload(unsupported, {
        os: "linux",
        arch: "x64",
      }).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      if (!Exit.isFailure(failed)) throw new Error("expected unsupported release to fail");
      const error = Option.getOrUndefined(Cause.findErrorOption(failed.cause));
      expect(error).toBeInstanceOf(StackPreparationError);
    }),
  );

  it.live("rejects unsupported native targets before selecting an artifact", () => {
    expect(targetForPlatform({ os: "win32", arch: "x64" })).toBeUndefined();
    expect(targetForPlatform({ os: "darwin", arch: "x64" })).toBeUndefined();
    return Effect.gen(function* () {
      const compiled = yield* compile({});
      const database = compiled.executionPlan.workloads.find(
        ({ recipeId }) => recipeId === "database:database",
      );
      const failed = yield* resolveNativeArtifactForWorkload(
        expectWorkload(database, "database workload"),
        { os: "win32", arch: "x64" },
      ).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      if (!Exit.isFailure(failed)) throw new Error("expected unsupported platform to fail");
      const error = Option.getOrUndefined(Cause.findErrorOption(failed.cause));
      expect(error).toBeInstanceOf(StackPreparationError);
    });
  });
});
