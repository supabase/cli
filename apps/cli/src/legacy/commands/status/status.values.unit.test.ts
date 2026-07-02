import { ProjectConfigSchema, type ProjectConfig } from "@supabase/config";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  legacyStatusContainerIds,
  legacyStatusValues,
  type LegacyStatusContainerIds,
} from "./status.values.ts";

const decodeConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

function baseConfig(overrides: Record<string, unknown> = {}): ProjectConfig {
  return decodeConfig({ project_id: "test", ...overrides });
}

const CONTAINER_IDS: LegacyStatusContainerIds = {
  kong: "supabase_kong_test",
  auth: "supabase_auth_test",
  inbucket: "supabase_inbucket_test",
  rest: "supabase_rest_test",
  storage: "supabase_storage_test",
  studio: "supabase_studio_test",
  edgeRuntime: "supabase_edge_runtime_test",
};

const HOSTNAME = "127.0.0.1";
const NONE: ReadonlyArray<string> = [];
const NO_OVERRIDES = new Map<string, string>();

describe("legacyStatusValues", () => {
  it("emits DB_URL unconditionally, even when every other service is disabled/excluded", () => {
    const config = baseConfig({
      api: { enabled: false },
      studio: { enabled: false },
      auth: { enabled: false },
      local_smtp: { enabled: false },
      storage: { enabled: false },
      edge_runtime: { enabled: false },
    });
    const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
    expect(Object.keys(values)).toEqual(["DB_URL"]);
    expect(values.DB_URL).toContain("postgresql://postgres:postgres@127.0.0.1");
  });

  describe("api / kong gating", () => {
    it("includes API_URL when api.enabled", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        NONE,
        NO_OVERRIDES,
      );
      expect(values.API_URL).toBeDefined();
    });

    it("omits API_URL when api.enabled is false", () => {
      const config = baseConfig({ api: { enabled: false } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.API_URL).toBeUndefined();
    });

    it("omits API_URL when the kong container id is excluded", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        [CONTAINER_IDS.kong],
        NO_OVERRIDES,
      );
      expect(values.API_URL).toBeUndefined();
    });

    it("omits REST/GraphQL when kong is disabled even though postgrest is enabled", () => {
      const config = baseConfig({ api: { enabled: false } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.REST_URL).toBeUndefined();
      expect(values.GRAPHQL_URL).toBeUndefined();
    });

    it("omits REST/GraphQL when only the rest container id is excluded", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        [CONTAINER_IDS.rest],
        NO_OVERRIDES,
      );
      expect(values.API_URL).toBeDefined();
      expect(values.REST_URL).toBeUndefined();
      expect(values.GRAPHQL_URL).toBeUndefined();
    });

    it("includes REST/GraphQL when kong and postgrest are both enabled", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        NONE,
        NO_OVERRIDES,
      );
      expect(values.REST_URL).toBeDefined();
      expect(values.GRAPHQL_URL).toBeDefined();
    });
  });

  describe("functions gating", () => {
    it("includes FUNCTIONS_URL when kong and edge_runtime are both enabled", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        NONE,
        NO_OVERRIDES,
      );
      expect(values.FUNCTIONS_URL).toBeDefined();
    });

    it("omits FUNCTIONS_URL when edge_runtime.enabled is false", () => {
      const config = baseConfig({ edge_runtime: { enabled: false } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.FUNCTIONS_URL).toBeUndefined();
    });

    it("omits FUNCTIONS_URL when kong is disabled even though edge_runtime is enabled", () => {
      const config = baseConfig({ api: { enabled: false } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.FUNCTIONS_URL).toBeUndefined();
    });

    it("omits FUNCTIONS_URL when the edge_runtime container id is excluded", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        [CONTAINER_IDS.edgeRuntime],
        NO_OVERRIDES,
      );
      expect(values.FUNCTIONS_URL).toBeUndefined();
    });
  });

  describe("studio / mcp gating", () => {
    it("includes STUDIO_URL when studio.enabled", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        NONE,
        NO_OVERRIDES,
      );
      expect(values.STUDIO_URL).toBeDefined();
    });

    it("omits STUDIO_URL when studio.enabled is false", () => {
      const config = baseConfig({ studio: { enabled: false } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.STUDIO_URL).toBeUndefined();
    });

    it("omits STUDIO_URL when the studio container id is excluded", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        [CONTAINER_IDS.studio],
        NO_OVERRIDES,
      );
      expect(values.STUDIO_URL).toBeUndefined();
    });

    it("includes MCP_URL only when both kong and studio are enabled", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        NONE,
        NO_OVERRIDES,
      );
      expect(values.MCP_URL).toBeDefined();
    });

    it("omits MCP_URL when kong is disabled", () => {
      const config = baseConfig({ api: { enabled: false } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.MCP_URL).toBeUndefined();
    });

    it("omits MCP_URL when studio is disabled", () => {
      const config = baseConfig({ studio: { enabled: false } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.MCP_URL).toBeUndefined();
    });
  });

  describe("auth gating", () => {
    it("includes all 5 auth fields when auth.enabled", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        NONE,
        NO_OVERRIDES,
      );
      expect(values.PUBLISHABLE_KEY).toBeDefined();
      expect(values.SECRET_KEY).toBeDefined();
      expect(values.JWT_SECRET).toBeDefined();
      expect(values.ANON_KEY).toBeDefined();
      expect(values.SERVICE_ROLE_KEY).toBeDefined();
    });

    it("omits all 5 auth fields when auth.enabled is false", () => {
      const config = baseConfig({ auth: { enabled: false } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.PUBLISHABLE_KEY).toBeUndefined();
      expect(values.SECRET_KEY).toBeUndefined();
      expect(values.JWT_SECRET).toBeUndefined();
      expect(values.ANON_KEY).toBeUndefined();
      expect(values.SERVICE_ROLE_KEY).toBeUndefined();
    });

    it("omits all 5 auth fields when the auth container id is excluded", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        [CONTAINER_IDS.auth],
        NO_OVERRIDES,
      );
      expect(values.PUBLISHABLE_KEY).toBeUndefined();
    });
  });

  describe("inbucket/mailpit gating", () => {
    it("includes MAILPIT_URL and the deprecated INBUCKET_URL alias when local_smtp.enabled", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        NONE,
        NO_OVERRIDES,
      );
      expect(values.MAILPIT_URL).toBeDefined();
      expect(values.INBUCKET_URL).toBe(values.MAILPIT_URL);
    });

    it("omits MAILPIT_URL/INBUCKET_URL when local_smtp.enabled is false", () => {
      const config = baseConfig({ local_smtp: { enabled: false } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.MAILPIT_URL).toBeUndefined();
      expect(values.INBUCKET_URL).toBeUndefined();
    });

    it("omits MAILPIT_URL/INBUCKET_URL when the inbucket container id is excluded", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        [CONTAINER_IDS.inbucket],
        NO_OVERRIDES,
      );
      expect(values.MAILPIT_URL).toBeUndefined();
    });
  });

  describe("storage / s3 gating", () => {
    it("includes all 4 storage S3 fields when storage.enabled and s3_protocol.enabled", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        NONE,
        NO_OVERRIDES,
      );
      expect(values.STORAGE_S3_URL).toBeDefined();
      expect(values.S3_PROTOCOL_ACCESS_KEY_ID).toBeDefined();
      expect(values.S3_PROTOCOL_ACCESS_KEY_SECRET).toBeDefined();
      expect(values.S3_PROTOCOL_REGION).toBeDefined();
    });

    it("omits storage S3 fields when storage.enabled is false", () => {
      const config = baseConfig({ storage: { enabled: false } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.STORAGE_S3_URL).toBeUndefined();
    });

    it("omits storage S3 fields when the storage container id is excluded", () => {
      const { values } = legacyStatusValues(
        baseConfig(),
        CONTAINER_IDS,
        HOSTNAME,
        [CONTAINER_IDS.storage],
        NO_OVERRIDES,
      );
      expect(values.STORAGE_S3_URL).toBeUndefined();
    });

    it("omits storage S3 fields when storage.s3_protocol.enabled is false", () => {
      const config = baseConfig({ storage: { s3_protocol: { enabled: false } } });
      const { values } = legacyStatusValues(config, CONTAINER_IDS, HOSTNAME, NONE, NO_OVERRIDES);
      expect(values.STORAGE_S3_URL).toBeUndefined();
      expect(values.S3_PROTOCOL_ACCESS_KEY_ID).toBeUndefined();
    });
  });

  describe("--override-name remapping", () => {
    it("remaps a field's output KEY while leaving the value unchanged", () => {
      const overrides = new Map([["api.url", "NEXT_PUBLIC_SUPABASE_URL"]]);
      const { values } = legacyStatusValues(baseConfig(), CONTAINER_IDS, HOSTNAME, NONE, overrides);
      expect(values.API_URL).toBeUndefined();
      expect(values.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    });

    it("remaps every field independently when multiple overrides are given", () => {
      const overrides = new Map([
        ["api.url", "CUSTOM_API_URL"],
        ["db.url", "CUSTOM_DB_URL"],
      ]);
      const { values } = legacyStatusValues(baseConfig(), CONTAINER_IDS, HOSTNAME, NONE, overrides);
      expect(values.CUSTOM_API_URL).toBeDefined();
      expect(values.CUSTOM_DB_URL).toBeDefined();
      expect(values.API_URL).toBeUndefined();
      expect(values.DB_URL).toBeUndefined();
    });

    it("leaves unrelated fields at their default name when only one is overridden", () => {
      const overrides = new Map([["api.url", "CUSTOM_API_URL"]]);
      const { values } = legacyStatusValues(baseConfig(), CONTAINER_IDS, HOSTNAME, NONE, overrides);
      expect(values.REST_URL).toBeDefined();
    });

    it("remaps the deprecated auth.jwt_secret/anon_key/service_role_key keys", () => {
      const overrides = new Map([
        ["auth.jwt_secret", "CUSTOM_JWT_SECRET"],
        ["auth.anon_key", "CUSTOM_ANON_KEY"],
        ["auth.service_role_key", "CUSTOM_SERVICE_ROLE_KEY"],
      ]);
      const { values } = legacyStatusValues(baseConfig(), CONTAINER_IDS, HOSTNAME, NONE, overrides);
      expect(values.CUSTOM_JWT_SECRET).toBeDefined();
      expect(values.CUSTOM_ANON_KEY).toBeDefined();
      expect(values.CUSTOM_SERVICE_ROLE_KEY).toBeDefined();
      expect(values.JWT_SECRET).toBeUndefined();
      expect(values.ANON_KEY).toBeUndefined();
      expect(values.SERVICE_ROLE_KEY).toBeUndefined();
    });

    it("remaps the deprecated inbucket.url key independently of mailpit.url", () => {
      const overrides = new Map([["inbucket.url", "CUSTOM_INBUCKET_URL"]]);
      const { values } = legacyStatusValues(baseConfig(), CONTAINER_IDS, HOSTNAME, NONE, overrides);
      expect(values.CUSTOM_INBUCKET_URL).toBeDefined();
      expect(values.MAILPIT_URL).toBeDefined();
      expect(values.INBUCKET_URL).toBeUndefined();
    });
  });

  it("combines stopped-service exclusions with --exclude flag exclusions", () => {
    // Both `stopped` (from the health-check diff) and `--exclude` (user flag)
    // funnel into the same `excluded` array in the handler; the pure function
    // only sees the merged list.
    const excluded = [CONTAINER_IDS.storage, CONTAINER_IDS.studio];
    const { values } = legacyStatusValues(
      baseConfig(),
      CONTAINER_IDS,
      HOSTNAME,
      excluded,
      NO_OVERRIDES,
    );
    expect(values.STORAGE_S3_URL).toBeUndefined();
    expect(values.STUDIO_URL).toBeUndefined();
    expect(values.API_URL).toBeDefined();
  });
});

describe("legacyStatusContainerIds", () => {
  it("derives every named field from legacyServiceContainerIds's fixed array order", () => {
    const ids = legacyStatusContainerIds("demo");
    expect(ids).toEqual({
      kong: "supabase_kong_demo",
      auth: "supabase_auth_demo",
      inbucket: "supabase_inbucket_demo",
      rest: "supabase_rest_demo",
      storage: "supabase_storage_demo",
      studio: "supabase_studio_demo",
      edgeRuntime: "supabase_edge_runtime_demo",
    });
  });
});
