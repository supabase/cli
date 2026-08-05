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
  it("maps API and database topology into the stack interface", async () => {
    const result = await Effect.runPromise(
      resolveLocalStackLaunch({
        ...baseLaunchInput,
        loadedProjectConfig: loaded({
          api: {
            enabled: true,
            port: 6101,
            schemas: ["public", "private_api"],
            extra_search_path: ["extensions"],
            max_rows: 250,
          },
          db: { port: 6102 },
        }),
      }),
    );

    expect(result.stackConfig).toMatchObject({
      port: 6101,
      postgres: { port: 6102 },
      postgrest: {
        schemas: ["public", "private_api"],
        extraSearchPath: ["extensions"],
        maxRows: 250,
      },
    });
  });

  it("applies environment overrides before CLI exclusions", async () => {
    const result = await Effect.runPromise(
      resolveLocalStackLaunch({
        ...baseLaunchInput,
        loadedProjectConfig: loaded({ api: { enabled: false, port: 6101 }, db: { port: 6102 } }),
        projectEnvironment: {
          paths: {
            projectRoot: "/project",
            supabaseDir: "/project/supabase",
            configPath: "/project/supabase/config.toml",
            envPath: "/project/supabase/.env",
            envLocalPath: "/project/supabase/.env.local",
          },
          values: {
            SUPABASE_API_ENABLED: "true",
            SUPABASE_API_PORT: "6201",
            SUPABASE_DB_PORT: "6202",
          },
          loadedPaths: [],
          sources: {},
        },
        exclude: ["postgrest"],
      }),
    );

    expect(result.stackConfig.port).toBe(6201);
    expect(result.stackConfig.postgres?.port).toBe(6202);
    expect(result.stackConfig.postgrest).toBe(false);
  });

  it("reports malformed topology overrides by path without retaining their value", async () => {
    const exit = await Effect.runPromise(
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
          values: { SUPABASE_DB_PORT: "private-invalid-value" },
          loadedPaths: [],
          sources: {},
        },
      }).pipe(Effect.exit),
    );

    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("db.port");
    expect(JSON.stringify(exit)).not.toContain("private-invalid-value");
  });

  it("only requests Mailpit protocol publication for explicit host ports", async () => {
    const omitted = await Effect.runPromise(
      resolveLocalStackLaunch({
        ...baseLaunchInput,
        loadedProjectConfig: loaded({ local_smtp: { enabled: true, port: 6104 } }),
      }),
    );
    const explicit = await Effect.runPromise(
      resolveLocalStackLaunch({
        ...baseLaunchInput,
        loadedProjectConfig: loaded({
          local_smtp: { enabled: true, port: 6104, smtp_port: 6105, pop3_port: 6106 },
        }),
      }),
    );

    expect(omitted.stackConfig.mailpit).toEqual(
      expect.not.objectContaining({ smtpPort: expect.anything(), pop3Port: expect.anything() }),
    );
    expect(explicit.stackConfig.mailpit).toEqual(
      expect.objectContaining({ port: 6104, smtpPort: 6105, pop3Port: 6106 }),
    );
  });

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
    expect(result.stackConfig.postgres?.startupHealthTimeoutMs).toBe(120_000);
    expect(result.stackConfig.readiness).toEqual({ mode: "finite", timeoutMs: 150_000 });
    expect(result.warnings.map(({ code }) => code)).toEqual([
      "unsupported",
      "unmatched-seed-pattern",
      "deprecated",
    ]);
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

    expect(result.stackConfig.postgres?.startupHealthTimeoutMs).toBe(5_000);
    expect(result.stackConfig.readiness).toEqual({ mode: "finite", timeoutMs: 35_000 });
  });

  it("supports an explicit infinite debugging policy while retaining startup health", async () => {
    const result = await Effect.runPromise(
      resolveLocalStackLaunch({ ...baseLaunchInput, readiness: "infinite" }),
    );

    expect(result.stackConfig.postgres?.startupHealthTimeoutMs).toBe(120_000);
    expect(result.stackConfig.readiness).toEqual({ mode: "infinite" });
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

  it("fails on explicit blocking fields and reports paths without values", async () => {
    const exit = await Effect.runPromise(
      resolveLocalStackLaunch({
        ...baseLaunchInput,
        loadedProjectConfig: loaded({
          auth: { captcha: { secret: "do-not-leak" } },
          api: { tls: { cert_path: "another-private-value" } },
          db: { migrations: { schema_paths: ["./private-schema.sql"] } },
          storage: { buckets: { images: { objects_path: "third-private-value" } } },
        }),
      }).pipe(Effect.exit),
    );

    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("auth.captcha.secret");
    expect(JSON.stringify(exit)).toContain("api.tls.cert_path");
    expect(JSON.stringify(exit)).toContain("db.migrations.schema_paths");
    expect(JSON.stringify(exit)).toContain("storage.buckets.images.objects_path");
    expect(JSON.stringify(exit)).not.toContain("do-not-leak");
    expect(JSON.stringify(exit)).not.toContain("another-private-value");
    expect(JSON.stringify(exit)).not.toContain("third-private-value");
  });

  it("warns on explicit warning fields using paths only", async () => {
    const result = await Effect.runPromise(
      resolveLocalStackLaunch({
        ...baseLaunchInput,
        loadedProjectConfig: loaded({
          experimental: { s3_secret_key: "do-not-leak" },
        }),
      }),
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "unsupported", paths: ["experimental.s3_secret_key"] }),
      expect.objectContaining({
        code: "unmatched-seed-pattern",
        paths: ["db.seed.sql_paths"],
      }),
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain("do-not-leak");
  });
});
