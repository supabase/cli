import { ProjectConfigSchema, type ProjectConfig } from "@supabase/config";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { legacyResolveLocalConfigValues } from "./legacy-local-config-values.ts";

const decodeConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

function baseConfig(overrides: Record<string, unknown> = {}): ProjectConfig {
  return decodeConfig({ project_id: "test", ...overrides });
}

describe("legacyResolveLocalConfigValues", () => {
  it("derives every URL from api.external_url when unset", () => {
    const config = baseConfig();
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1");

    expect(values.apiUrl).toBe("http://127.0.0.1:54321");
    expect(values.restUrl).toBe("http://127.0.0.1:54321/rest/v1");
    expect(values.graphqlUrl).toBe("http://127.0.0.1:54321/graphql/v1");
    expect(values.functionsUrl).toBe("http://127.0.0.1:54321/functions/v1");
    expect(values.mcpUrl).toBe("http://127.0.0.1:54321/mcp");
    expect(values.storageS3Url).toBe("http://127.0.0.1:54321/storage/v1/s3");
    expect(values.studioUrl).toBe("http://127.0.0.1:54323");
    expect(values.mailpitUrl).toBe("http://127.0.0.1:54324");
  });

  it("uses https and the configured port when api.tls.enabled", () => {
    const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1");
    expect(values.apiUrl).toBe("https://127.0.0.1:54321");
  });

  it("uses api.external_url verbatim when configured", () => {
    const config = baseConfig({ api: { external_url: "https://example.test" } });
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1");
    expect(values.apiUrl).toBe("https://example.test");
    expect(values.restUrl).toBe("https://example.test/rest/v1");
  });

  it("brackets an IPv6 hostname when building host:port", () => {
    const config = baseConfig();
    const values = legacyResolveLocalConfigValues(config, "::1");
    expect(values.apiUrl).toBe("http://[::1]:54321");
  });

  it("builds the db URL with the hardcoded postgres password", () => {
    const config = baseConfig({ db: { port: 54322 } });
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1");
    expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  });

  it("falls back to the default JWT secret and opaque keys when unset", () => {
    const config = baseConfig();
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1");
    expect(values.jwtSecret).toBe("super-secret-jwt-token-with-at-least-32-characters-long");
    expect(values.publishableKey).toBe("sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH");
    expect(values.secretKey).toBe("sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz");
  });

  it("uses configured opaque keys verbatim when set", () => {
    const config = baseConfig({
      auth: { publishable_key: "sb_publishable_custom", secret_key: "sb_secret_custom" },
    });
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1");
    expect(values.publishableKey).toBe("sb_publishable_custom");
    expect(values.secretKey).toBe("sb_secret_custom");
  });

  it("signs the default anon/service_role JWTs from the resolved secret", () => {
    const config = baseConfig();
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1");
    // Byte-exact Go-parity shape is covered by legacy-go-jwt.unit.test.ts; here we
    // only assert the resolver wires the default secret through to both roles.
    const [, anonPayload] = values.anonKey.split(".");
    const [, serviceRolePayload] = values.serviceRoleKey.split(".");
    expect(JSON.parse(Buffer.from(anonPayload ?? "", "base64url").toString())).toMatchObject({
      role: "anon",
    });
    expect(JSON.parse(Buffer.from(serviceRolePayload ?? "", "base64url").toString())).toMatchObject(
      { role: "service_role" },
    );
  });

  it("uses configured anon/service_role keys verbatim when set", () => {
    const config = baseConfig({
      auth: { anon_key: "configured-anon", service_role_key: "configured-service-role" },
    });
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1");
    expect(values.anonKey).toBe("configured-anon");
    expect(values.serviceRoleKey).toBe("configured-service-role");
  });

  it("signs anon/service_role JWTs from a configured jwt_secret", () => {
    const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1");
    expect(values.jwtSecret).toBe("a".repeat(32));
    expect(values.anonKey).not.toBe("");
  });

  it("hardcodes the Go-parity local S3 credentials", () => {
    const config = baseConfig();
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1");
    expect(values.storageS3AccessKeyId).toBe("625729a08b95bf1b7ff351a663f3a23c");
    expect(values.storageS3SecretAccessKey).toBe(
      "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
    );
    expect(values.storageS3Region).toBe("local");
  });
});
