import { ProjectConfigSchema, type LoadedProjectConfig } from "@supabase/config";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AUTO_EXPOSE_NEW_TABLES_DEPRECATION_WARNING,
  baseStackConfig,
  explicitLocalStackConfigEntries,
  resolveAutoExposeNewTables,
  resolveLocalStackLaunch,
  resolveStoredStackLaunch,
} from "./stack-config.ts";

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

function loaded(document: Record<string, unknown>): LoadedProjectConfig {
  return {
    path: "/project/supabase/config.toml",
    format: "toml",
    config: decodeProjectConfig(document),
    document,
    ignoredPaths: [],
  };
}

const baseLaunchInput = {
  loadedProjectConfig: null,
  projectEnvironment: null,
  projectPaths: {
    projectRoot: "/project",
    projectStateRoot: "/project/.supabase",
  },
  mode: "auto" as const,
  exclude: [],
  runtimeVersions: {},
};

describe("resolveAutoExposeNewTables", () => {
  it("preserves the presence-sensitive tri-state behavior", () => {
    expect(resolveAutoExposeNewTables(undefined)).toEqual({
      autoExposeNewTables: false,
      deprecationWarning: undefined,
    });
    expect(resolveAutoExposeNewTables(false)).toEqual({
      autoExposeNewTables: false,
      deprecationWarning: undefined,
    });
    expect(resolveAutoExposeNewTables(true)).toEqual({
      autoExposeNewTables: true,
      deprecationWarning: AUTO_EXPOSE_NEW_TABLES_DEPRECATION_WARNING,
    });
  });
});

describe("baseStackConfig", () => {
  it("uses lazy service startup with the requested runtime mode", () => {
    expect(baseStackConfig([], "auto")).toMatchObject({ mode: "auto", startupMode: "lazy" });
    expect(baseStackConfig([], "docker")).toMatchObject({ mode: "docker", startupMode: "lazy" });
    expect(baseStackConfig([], "native")).toMatchObject({ mode: "native", startupMode: "lazy" });
  });

  it("deduplicates exclusions and keeps dependent services disabled", () => {
    expect(baseStackConfig(["auth", "auth", "storage"], "auto")).toMatchObject({
      auth: false,
      storage: false,
      imgproxy: false,
    });
  });
});

describe("resolveStoredStackLaunch", () => {
  it("injects linked versions without re-enabling excluded services", () => {
    expect(
      resolveStoredStackLaunch({
        exclude: ["auth", "storage"],
        mode: "auto",
        runtimeVersions: {
          postgres: "17.6.1.090",
          auth: "2.187.0",
          storage: "1.39.2",
        },
      }),
    ).toMatchObject({
      postgres: { version: "17.6.1.090" },
      auth: false,
      storage: false,
    });
  });
});

describe("explicitLocalStackConfigEntries", () => {
  it("expands dynamic record paths and never includes secret values", () => {
    const projectConfig = decodeProjectConfig({
      functions: {
        hello: { entrypoint: "./functions/hello/index.ts" },
      },
      auth: { jwt_secret: "do-not-return" },
    });
    const entries = explicitLocalStackConfigEntries({
      projectConfig,
      rawDocument: {
        functions: { hello: { entrypoint: "./functions/hello/index.ts" } },
        auth: { jwt_secret: "do-not-return" },
      },
    });

    expect(entries.map(({ path }) => path)).toContain("functions.hello.entrypoint");
    expect(entries.map(({ path }) => path)).toContain("auth.jwt_secret");
    expect(JSON.stringify(entries)).not.toContain("do-not-return");
  });
});

describe("resolveLocalStackLaunch", () => {
  it("composes project config, paths, flags, versions, and finite readiness", async () => {
    const result = await Effect.runPromise(
      resolveLocalStackLaunch({
        ...baseLaunchInput,
        loadedProjectConfig: loaded({
          api: { auto_expose_new_tables: true },
          db: { health_timeout: "2m" },
          experimental: { webhooks: { enabled: true } },
        }),
        mode: "docker",
        exclude: ["auth"],
        runtimeVersions: { postgres: "17.6.1.090" },
      }),
    );

    expect(result.stackConfig).toMatchObject({
      projectDir: "/project",
      mode: "docker",
      auth: false,
      postgres: { autoExposeNewTables: true, version: "17.6.1.090" },
    });
    expect(result.projectPaths.projectStateRoot).toBe("/project/.supabase");
    expect(result.postgresStartupTimeoutMs).toBe(120_000);
    expect(result.readiness).toEqual({ mode: "finite", timeoutMs: 150_000 });
    expect(result.warnings.map(({ code }) => code)).toEqual(["unsupported", "deprecated"]);
    expect(result.unsupported.map(({ path }) => path)).toContain("db.health_timeout");
  });

  it("uses the resolved project environment for the database health timeout", async () => {
    const result = await Effect.runPromise(
      resolveLocalStackLaunch({
        ...baseLaunchInput,
        projectEnvironment: {
          paths: {
            projectRoot: "/project",
            supabaseDir: "/project/supabase",
            configPath: "/project/supabase/config.toml",
            envPath: "/project/supabase/.env",
            envLocalPath: "/project/supabase/.env.local",
          },
          values: { SUPABASE_DB_HEALTH_TIMEOUT: "5s" },
          loadedPaths: [],
          sources: { SUPABASE_DB_HEALTH_TIMEOUT: "ambient" },
        },
      }),
    );

    expect(result.postgresStartupTimeoutMs).toBe(5_000);
    expect(result.readiness).toEqual({ mode: "finite", timeoutMs: 35_000 });
  });

  it("supports an explicit infinite debugging policy while retaining startup health", async () => {
    const result = await Effect.runPromise(
      resolveLocalStackLaunch({ ...baseLaunchInput, readiness: "infinite" }),
    );

    expect(result.postgresStartupTimeoutMs).toBe(120_000);
    expect(result.readiness).toEqual({ mode: "infinite" });
  });

  it("fails before stack construction when the health timeout is invalid", async () => {
    const exit = await Effect.runPromise(
      resolveLocalStackLaunch({
        ...baseLaunchInput,
        loadedProjectConfig: loaded({ db: { health_timeout: "-1s" } }),
      }).pipe(Effect.exit),
    );

    expect(exit._tag).toBe("Failure");
  });
});
