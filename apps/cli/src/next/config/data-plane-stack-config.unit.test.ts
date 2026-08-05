import {
  ProjectConfigSchema,
  type LoadedProjectConfig,
  type ProjectEnvironment,
} from "@supabase/config";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { resolveDataPlaneStackConfig } from "./data-plane-stack-config.ts";

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

function environment(values: Readonly<Record<string, string>>): ProjectEnvironment {
  return {
    paths: {
      projectRoot: "/project",
      supabaseDir: "/project/supabase",
      configPath: "/project/supabase/config.toml",
      envPath: "/project/supabase/.env",
      envLocalPath: "/project/supabase/.env.local",
    },
    values,
    loadedPaths: [],
    sources: {},
  };
}

describe("resolveDataPlaneStackConfig", () => {
  it("translates project values and legacy environment overrides", () => {
    const projectConfig = decodeProjectConfig({
      realtime: { ip_version: "IPv4", max_header_length: 4096 },
      storage: {
        file_size_limit: "50MiB",
        s3_protocol: { enabled: true },
        vector: { enabled: true },
      },
      analytics: {
        enabled: true,
        backend: "bigquery",
        gcp_project_id: "config-project",
        gcp_project_number: "123",
        gcp_jwt_path: "credentials.json",
      },
      studio: { openai_api_key: "env(OPENAI_API_KEY)" },
      db: {
        pooler: {
          pool_mode: "transaction",
          default_pool_size: 20,
          max_client_conn: 100,
        },
      },
    });

    const resolved = resolveDataPlaneStackConfig({
      loadedProjectConfig: null,
      projectConfig,
      projectEnvironment: environment({
        SUPABASE_REALTIME_IP_VERSION: "IPv6",
        SUPABASE_REALTIME_MAX_HEADER_LENGTH: "0x2000",
        SUPABASE_STORAGE_FILE_SIZE_LIMIT: "5MiB",
        SUPABASE_STORAGE_S3_PROTOCOL_ENABLED: "false",
        SUPABASE_STORAGE_VECTOR_ENABLED: "true",
        VECTOR_BUCKET_PROVIDER: "custom-provider",
        VECTOR_STORE_MIGRATIONS_ENABLED: "",
        VECTOR_DATABASE_URL: "postgresql://vector-secret",
        SUPABASE_ANALYTICS_GCP_PROJECT_ID: "environment-project",
        OPENAI_API_KEY: "openai-secret",
        SUPABASE_DB_POOLER_POOL_MODE: "session",
        SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE: "0x20",
        SUPABASE_DB_POOLER_MAX_CLIENT_CONN: "0200",
      }),
      configDir: "/project/supabase",
      base: { realtime: {}, storage: {}, analytics: {}, studio: {}, pooler: {} },
    });

    expect(resolved.realtime).toMatchObject({ ipVersion: "IPv6", maxHeaderLength: 8192 });
    expect(resolved.storage).toMatchObject({
      fileSizeLimit: "5242880",
      s3ProtocolEnabled: false,
      vectorRuntime: {
        enabled: "true",
        provider: "custom-provider",
        migrationsEnabled: "",
        databaseUrl: "postgresql://vector-secret",
      },
    });
    expect(resolved.analytics).toMatchObject({
      backend: "bigquery",
      gcp: {
        projectId: "environment-project",
        projectNumber: "123",
        credentialsPath: "/project/supabase/credentials.json",
      },
    });
    expect(resolved.studio).toMatchObject({ openAiApiKey: "openai-secret" });
    expect(resolved.pooler).toMatchObject({
      mode: "session",
      defaultPoolSize: 32,
      maxClientConn: 128,
    });
  });

  it("preserves exclusions while still validating environment overrides", () => {
    const projectConfig = decodeProjectConfig({ analytics: { enabled: false } });
    const resolved = resolveDataPlaneStackConfig({
      loadedProjectConfig: null,
      projectConfig,
      projectEnvironment: null,
      configDir: "/project/supabase",
      base: { realtime: false, storage: false, analytics: false, studio: false, pooler: false },
    });
    expect(resolved).toMatchObject({
      realtime: false,
      storage: false,
      analytics: false,
      studio: false,
      pooler: false,
    });

    const privateValue = "private-invalid-transport";
    expect(() =>
      resolveDataPlaneStackConfig({
        loadedProjectConfig: null,
        projectConfig,
        projectEnvironment: environment({ SUPABASE_REALTIME_IP_VERSION: privateValue }),
        configDir: "/project/supabase",
        base: { realtime: false },
      }),
    ).toThrowError(expect.objectContaining({ paths: ["realtime.ip_version"] }));
    try {
      resolveDataPlaneStackConfig({
        loadedProjectConfig: null,
        projectConfig,
        projectEnvironment: environment({ SUPABASE_REALTIME_IP_VERSION: privateValue }),
        configDir: "/project/supabase",
        base: { realtime: false },
      });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(privateValue);
    }
  });

  it("keeps selected remote values ahead of legacy environment bindings", () => {
    const document = {
      realtime: { ip_version: "IPv6", max_header_length: 8192 },
      storage: { file_size_limit: "5MiB", s3_protocol: { enabled: false } },
      analytics: {
        enabled: true,
        backend: "bigquery",
        gcp_project_id: "remote-project",
        gcp_project_number: "123",
        gcp_jwt_path: "remote.json",
      },
      studio: { openai_api_key: "remote-openai" },
      db: { pooler: { pool_mode: "session", default_pool_size: 32, max_client_conn: 128 } },
    };
    const projectConfig = decodeProjectConfig(document);
    const remoteOverridePaths = [
      "realtime.ip_version",
      "realtime.max_header_length",
      "storage.file_size_limit",
      "storage.s3_protocol.enabled",
      "analytics.enabled",
      "analytics.backend",
      "analytics.gcp_project_id",
      "analytics.gcp_project_number",
      "analytics.gcp_jwt_path",
      "studio.openai_api_key",
      "db.pooler.pool_mode",
      "db.pooler.default_pool_size",
      "db.pooler.max_client_conn",
    ];
    const loaded: LoadedProjectConfig = {
      path: "/project/supabase/config.toml",
      format: "toml",
      config: projectConfig,
      document,
      appliedRemote: "preview",
      remoteOverridePaths,
      ignoredPaths: [],
    };

    const resolved = resolveDataPlaneStackConfig({
      loadedProjectConfig: loaded,
      projectConfig,
      projectEnvironment: environment({
        SUPABASE_REALTIME_IP_VERSION: "invalid-private-value",
        SUPABASE_REALTIME_MAX_HEADER_LENGTH: "invalid-private-value",
        SUPABASE_STORAGE_FILE_SIZE_LIMIT: "invalid-private-value",
        SUPABASE_STORAGE_S3_PROTOCOL_ENABLED: "invalid-private-value",
        SUPABASE_ANALYTICS_ENABLED: "false",
        SUPABASE_ANALYTICS_BACKEND: "postgres",
        SUPABASE_ANALYTICS_GCP_PROJECT_ID: "environment-project",
        SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER: "999",
        SUPABASE_ANALYTICS_GCP_JWT_PATH: "environment.json",
        SUPABASE_STUDIO_OPENAI_API_KEY: "environment-openai",
        SUPABASE_DB_POOLER_POOL_MODE: "invalid-private-value",
        SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE: "invalid-private-value",
        SUPABASE_DB_POOLER_MAX_CLIENT_CONN: "invalid-private-value",
      }),
      configDir: "/project/supabase",
      base: { realtime: {}, storage: {}, analytics: {}, studio: {}, pooler: {} },
    });

    expect(resolved).toMatchObject({
      realtime: { ipVersion: "IPv6", maxHeaderLength: 8192 },
      storage: { fileSizeLimit: "5242880", s3ProtocolEnabled: false },
      analytics: {
        backend: "bigquery",
        gcp: {
          projectId: "remote-project",
          projectNumber: "123",
          credentialsPath: "/project/supabase/remote.json",
        },
      },
      studio: { openAiApiKey: "remote-openai" },
      pooler: { mode: "session", defaultPoolSize: 32, maxClientConn: 128 },
    });
  });

  it("reports invalid sizes and missing BigQuery fields by path only", () => {
    const invalidSize = "private-invalid-size";
    const projectConfig = decodeProjectConfig({
      analytics: { enabled: true, backend: "bigquery" },
    });
    const scenarios: ReadonlyArray<{
      readonly values: Readonly<Record<string, string>>;
      readonly path: string;
    }> = [
      {
        values: { SUPABASE_STORAGE_FILE_SIZE_LIMIT: invalidSize },
        path: "storage.file_size_limit",
      },
      { values: {}, path: "analytics.gcp_project_id" },
    ];
    for (const scenario of scenarios) {
      try {
        resolveDataPlaneStackConfig({
          loadedProjectConfig: null,
          projectConfig,
          projectEnvironment: environment(scenario.values),
          configDir: "/project/supabase",
          base: { storage: {}, analytics: {} },
        });
        throw new Error("expected translator failure");
      } catch (error) {
        expect(error).toEqual(expect.objectContaining({ paths: [scenario.path] }));
        expect(JSON.stringify(error)).not.toContain(invalidSize);
      }
    }
  });
});
