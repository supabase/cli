import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ProjectConfigSchema, type ProjectConfig } from "@supabase/config";
import { Schema } from "effect";
import { importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyInvalidBoolEnvOverrideError,
  LegacyInvalidJwtSecretError,
  LegacyInvalidPortEnvOverrideError,
  legacyResolveLocalConfigValues,
} from "./legacy-local-config-values.ts";

const decodeConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
const WORKDIR = "/tmp/legacy-local-config-values-test";

function baseConfig(overrides: Record<string, unknown> = {}): ProjectConfig {
  return decodeConfig({ project_id: "test", ...overrides });
}

/** RSA JWK matching Go's `JWK` struct field names (kty/n/e/d/p/q/dp/dq/qi). */
function generateRsaJwk(): Record<string, unknown> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" });
  return { ...jwk, alg: "RS256", kid: "test-rsa-kid" };
}

function writeSigningKeys(workdir: string, jwks: ReadonlyArray<Record<string, unknown>>) {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "signing_keys.json"), JSON.stringify(jwks));
}

describe("legacyResolveLocalConfigValues", () => {
  it("derives every URL from api.external_url when unset", () => {
    const config = baseConfig();
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);

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
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.apiUrl).toBe("https://127.0.0.1:54321");
  });

  it("uses api.external_url verbatim when configured", () => {
    const config = baseConfig({ api: { external_url: "https://example.test" } });
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.apiUrl).toBe("https://example.test");
    expect(values.restUrl).toBe("https://example.test/rest/v1");
  });

  it("brackets an IPv6 hostname when building host:port", () => {
    const config = baseConfig();
    const values = legacyResolveLocalConfigValues(config, "::1", WORKDIR);
    expect(values.apiUrl).toBe("http://[::1]:54321");
  });

  it("builds the db URL with the hardcoded postgres password", () => {
    const config = baseConfig({ db: { port: 54322 } });
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  });

  it("falls back to the default JWT secret and opaque keys when unset", () => {
    const config = baseConfig();
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.jwtSecret).toBe("super-secret-jwt-token-with-at-least-32-characters-long");
    expect(values.publishableKey).toBe("sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH");
    expect(values.secretKey).toBe("sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz");
  });

  it("uses configured opaque keys verbatim when set", () => {
    const config = baseConfig({
      auth: { publishable_key: "sb_publishable_custom", secret_key: "sb_secret_custom" },
    });
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.publishableKey).toBe("sb_publishable_custom");
    expect(values.secretKey).toBe("sb_secret_custom");
  });

  it("signs the default anon/service_role JWTs from the resolved secret", () => {
    const config = baseConfig();
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
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
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.anonKey).toBe("configured-anon");
    expect(values.serviceRoleKey).toBe("configured-service-role");
  });

  it("signs anon/service_role JWTs from a configured jwt_secret", () => {
    const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.jwtSecret).toBe("a".repeat(32));
    expect(values.anonKey).not.toBe("");
  });

  it("rejects a configured jwt_secret shorter than 16 characters", () => {
    // Go's Config.Validate fails this at config-load time, before any command
    // can render output (pkg/config/apikeys.go:45-47) — reproduced as a thrown
    // error here rather than silently signing with the too-short secret.
    const config = baseConfig({ auth: { jwt_secret: "a".repeat(15) } });
    expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      LegacyInvalidJwtSecretError,
    );
  });

  it("rejects an explicit empty project_id, matching Go's Config.Validate", () => {
    // Go's Config.Validate checks ProjectId first, before any other field
    // (pkg/config/config.go:990-991). The workdir-basename default is merged
    // in as a viper default BEFORE config.toml is merged, so an explicit
    // `project_id = ""` in the file overwrites that default with the literal
    // empty string rather than being treated as absent — Go fails outright.
    const config = baseConfig({ project_id: "" });
    expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "Missing required field in config: project_id",
    );
  });

  it("does not reject an absent project_id (the workdir-basename default applies elsewhere)", () => {
    const config = Schema.decodeUnknownSync(ProjectConfigSchema)({});
    expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
  });

  it("lets SUPABASE_PROJECT_ID override an explicit empty project_id", () => {
    // Viper's AutomaticEnv binds SUPABASE_PROJECT_ID with higher precedence
    // than config.toml (config.go:529-535), so a non-empty env override must
    // win even when the file's project_id is explicitly empty.
    const config = baseConfig({ project_id: "" });
    expect(() =>
      legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, {
        SUPABASE_PROJECT_ID: "env-project",
      }),
    ).not.toThrow();
  });

  it("hardcodes the Go-parity local S3 credentials", () => {
    const config = baseConfig();
    const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.storageS3AccessKeyId).toBe("625729a08b95bf1b7ff351a663f3a23c");
    expect(values.storageS3SecretAccessKey).toBe(
      "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
    );
    expect(values.storageS3Region).toBe("local");
  });

  describe("SUPABASE_AUTH_* env overrides", () => {
    const tempRoot = useLegacyTempWorkdir("supabase-signing-keys-env-override-test-");

    // Go's Config.Load binds Viper with SetEnvPrefix("SUPABASE") + AutomaticEnv()
    // (pkg/config/config.go:529-535) — env vars take precedence over config.toml.
    const ENV_KEYS = [
      "SUPABASE_AUTH_JWT_SECRET",
      "SUPABASE_AUTH_PUBLISHABLE_KEY",
      "SUPABASE_AUTH_SECRET_KEY",
      "SUPABASE_AUTH_ANON_KEY",
      "SUPABASE_AUTH_SERVICE_ROLE_KEY",
      "SUPABASE_AUTH_SIGNING_KEYS_PATH",
    ] as const;

    afterEach(() => {
      for (const key of ENV_KEYS) delete process.env[key];
    });

    it("overrides jwt_secret even when config.toml sets one", () => {
      process.env["SUPABASE_AUTH_JWT_SECRET"] = "b".repeat(32);
      const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.jwtSecret).toBe("b".repeat(32));
    });

    it("overrides publishable_key/secret_key", () => {
      process.env["SUPABASE_AUTH_PUBLISHABLE_KEY"] = "env-publishable";
      process.env["SUPABASE_AUTH_SECRET_KEY"] = "env-secret";
      const config = baseConfig({
        auth: { publishable_key: "config-publishable", secret_key: "config-secret" },
      });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.publishableKey).toBe("env-publishable");
      expect(values.secretKey).toBe("env-secret");
    });

    it("overrides anon_key/service_role_key", () => {
      process.env["SUPABASE_AUTH_ANON_KEY"] = "env-anon";
      process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"] = "env-service-role";
      const config = baseConfig({
        auth: { anon_key: "config-anon", service_role_key: "config-service-role" },
      });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.anonKey).toBe("env-anon");
      expect(values.serviceRoleKey).toBe("env-service-role");
    });

    it("treats an empty env var as unset, matching Viper's default", () => {
      process.env["SUPABASE_AUTH_JWT_SECRET"] = "";
      const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.jwtSecret).toBe("a".repeat(32));
    });

    it("still applies the short-secret validation to an env-provided jwt_secret", () => {
      process.env["SUPABASE_AUTH_JWT_SECRET"] = "too-short";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        LegacyInvalidJwtSecretError,
      );
    });

    it("overrides signing_keys_path even when config.toml doesn't set one", async () => {
      const jwk = generateRsaJwk();
      writeSigningKeys(tempRoot.current, [jwk]);
      process.env["SUPABASE_AUTH_SIGNING_KEYS_PATH"] = "signing_keys.json";
      const config = baseConfig();
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);

      const publicJwk = { ...jwk, d: undefined, p: undefined, q: undefined, dp: undefined };
      const publicKey = await importJWK(publicJwk, "RS256");
      const { protectedHeader } = await jwtVerify(values.anonKey, publicKey);
      expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "test-rsa-kid" });
    });

    it("prefers an env-provided signing_keys_path over config.toml's", () => {
      const envJwk = { ...generateRsaJwk(), kid: "env-kid" };
      const configJwk = { ...generateRsaJwk(), kid: "config-kid" };
      writeSigningKeys(tempRoot.current, [envJwk]);
      const supabaseDir = join(tempRoot.current, "supabase");
      writeFileSync(join(supabaseDir, "other_keys.json"), JSON.stringify([configJwk]));
      process.env["SUPABASE_AUTH_SIGNING_KEYS_PATH"] = "signing_keys.json";
      const config = baseConfig({ auth: { signing_keys_path: "other_keys.json" } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
      const [header] = values.anonKey.split(".");
      expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toMatchObject({
        kid: "env-kid",
      });
    });
  });

  describe("non-auth SUPABASE_* env overrides", () => {
    // Go's Config.Load binds Viper with SetEnvPrefix("SUPABASE") + AutomaticEnv()
    // generically across the whole config struct (pkg/config/config.go:529-535),
    // not just auth fields — config_test.go:351,1061 exercise this against
    // auth.site_url, and status.go's toValues() reads the already-overridden
    // utils.Config.* directly, so every port/URL status derives must honor the
    // same override.
    const ENV_KEYS = [
      "SUPABASE_DB_PORT",
      "SUPABASE_STUDIO_PORT",
      "SUPABASE_LOCAL_SMTP_PORT",
      "SUPABASE_API_PORT",
      "SUPABASE_API_EXTERNAL_URL",
    ] as const;

    afterEach(() => {
      for (const key of ENV_KEYS) delete process.env[key];
    });

    it("overrides db.port for the derived DB URL", () => {
      process.env["SUPABASE_DB_PORT"] = "54329";
      const config = baseConfig({ db: { port: 54322 } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54329/postgres");
    });

    it("overrides studio.port for the derived Studio URL", () => {
      process.env["SUPABASE_STUDIO_PORT"] = "54330";
      const config = baseConfig({ studio: { port: 54323 } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.studioUrl).toBe("http://127.0.0.1:54330");
    });

    it("overrides local_smtp.port for the derived Mailpit URL", () => {
      process.env["SUPABASE_LOCAL_SMTP_PORT"] = "54331";
      const config = baseConfig({ local_smtp: { port: 54324 } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.mailpitUrl).toBe("http://127.0.0.1:54331");
    });

    it("overrides api.port for every API-derived URL", () => {
      process.env["SUPABASE_API_PORT"] = "54332";
      const config = baseConfig({ api: { port: 54321 } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("http://127.0.0.1:54332");
      expect(values.restUrl).toBe("http://127.0.0.1:54332/rest/v1");
    });

    it("overrides api.external_url even when config.toml sets one", () => {
      process.env["SUPABASE_API_EXTERNAL_URL"] = "https://env-override.example";
      const config = baseConfig({ api: { external_url: "https://config.example" } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("https://env-override.example");
    });

    it("treats an empty non-auth env var as unset, matching Viper's default", () => {
      process.env["SUPABASE_DB_PORT"] = "";
      const config = baseConfig({ db: { port: 54322 } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    });

    // Go's Config.Load decodes `SUPABASE_*_PORT` overrides as `uint16` via
    // Viper's UnmarshalExact (pkg/config/config.go:749-756, WeaklyTypedInput
    // decodes the override string with strconv.ParseUint and hard-fails on a
    // malformed value) rather than silently producing a `NaN`-laced URL.
    it.each([
      "SUPABASE_DB_PORT",
      "SUPABASE_STUDIO_PORT",
      "SUPABASE_LOCAL_SMTP_PORT",
      "SUPABASE_API_PORT",
    ] as const)("rejects a malformed %s override instead of producing NaN", (envKey) => {
      process.env[envKey] = "abc";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        LegacyInvalidPortEnvOverrideError,
      );
    });

    it("rejects a SUPABASE_DB_PORT override above the uint16 range", () => {
      process.env["SUPABASE_DB_PORT"] = "99999";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        LegacyInvalidPortEnvOverrideError,
      );
    });

    // Unlike the malformed/out-of-range cases above (a decode-time hard-fail,
    // uniform across all four SUPABASE_*_PORT fields), db.port=0 is a
    // Config.Validate-time hard-fail specific to db.port: it has no `enabled`
    // gate in Go, unlike api.port/studio.port/local_smtp.port
    // (pkg/config/config.go:1006-1009,1031-1032,1070-1073,1081-1084).
    it("rejects a zero SUPABASE_DB_PORT override, matching Go's required-field check", () => {
      process.env["SUPABASE_DB_PORT"] = "0";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: db.port",
      );
    });

    // Unlike db.port, Go gates the api.port===0 rejection on api.enabled
    // (pkg/config/config.go:1006-1008) — api.enabled defaults to true, so a
    // configured or env-overridden zero port is rejected by default.
    it("rejects a configured api.port of 0 when api is enabled", () => {
      const config = baseConfig({ api: { port: 0 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: api.port",
      );
    });

    it("rejects a zero SUPABASE_API_PORT override when api is enabled", () => {
      process.env["SUPABASE_API_PORT"] = "0";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: api.port",
      );
    });

    it("does not reject a zero api.port when api is disabled", () => {
      const config = baseConfig({ api: { enabled: false, port: 0 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    // Go gates the studio.port===0 rejection on studio.enabled
    // (pkg/config/config.go:1070-1073), same pattern as api.port above.
    // studio.enabled defaults to true, so a configured or env-overridden zero
    // port is rejected by default.
    it("rejects a configured studio.port of 0 when studio is enabled", () => {
      const config = baseConfig({ studio: { port: 0 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: studio.port",
      );
    });

    it("rejects a zero SUPABASE_STUDIO_PORT override when studio is enabled", () => {
      process.env["SUPABASE_STUDIO_PORT"] = "0";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: studio.port",
      );
    });

    it("does not reject a zero studio.port when studio is disabled", () => {
      const config = baseConfig({ studio: { enabled: false, port: 0 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    // Go gates the local_smtp.port===0 rejection on local_smtp.enabled (Go's
    // struct field is still named `Inbucket` for the `[local_smtp]` TOML
    // section, pkg/config/config.go:235,1081-1083), same pattern as api.port/
    // studio.port above. local_smtp.enabled defaults to true, so a configured
    // or env-overridden zero port is rejected by default.
    it("rejects a configured local_smtp.port of 0 when local_smtp is enabled", () => {
      const config = baseConfig({ local_smtp: { port: 0 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: local_smtp.port",
      );
    });

    it("rejects a zero SUPABASE_LOCAL_SMTP_PORT override when local_smtp is enabled", () => {
      process.env["SUPABASE_LOCAL_SMTP_PORT"] = "0";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: local_smtp.port",
      );
    });

    it("does not reject a zero local_smtp.port when local_smtp is disabled", () => {
      const config = baseConfig({ local_smtp: { enabled: false, port: 0 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("db.major_version (required field in config)", () => {
    afterEach(() => {
      delete process.env["SUPABASE_DB_MAJOR_VERSION"];
    });

    it("rejects a configured major_version of 0", () => {
      const config = baseConfig({ db: { major_version: 0 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: db.major_version",
      );
    });

    it("rejects the unsupported Postgres 12.x major_version with Go's dedicated message", () => {
      const config = baseConfig({ db: { major_version: 12 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Postgres version 12.x is unsupported.",
      );
    });

    it.each([13, 14, 15, 17])("accepts the supported major_version %d", (majorVersion) => {
      const config = baseConfig({ db: { major_version: majorVersion } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects an unsupported major_version with the generic invalid-value message", () => {
      const config = baseConfig({ db: { major_version: 16 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Failed reading config: Invalid db.major_version: 16.",
      );
    });

    it("overrides a valid configured major_version via SUPABASE_DB_MAJOR_VERSION", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "15";
      const config = baseConfig({ db: { major_version: 17 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects an unsupported SUPABASE_DB_MAJOR_VERSION override", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "16";
      const config = baseConfig({ db: { major_version: 17 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Failed reading config: Invalid db.major_version: 16.",
      );
    });

    it("rejects a non-numeric SUPABASE_DB_MAJOR_VERSION override", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "abc";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Failed reading config: Invalid db.major_version: abc.",
      );
    });

    it("treats an empty SUPABASE_DB_MAJOR_VERSION override as unset, matching Viper's default", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "";
      const config = baseConfig({ db: { major_version: 17 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  // Go's Config.Validate runs ValidateBucketName over every [storage.buckets.*]
  // key right after db.major_version, unconditionally — there is no
  // storage.enabled-style gate (pkg/config/config.go:1063-1068).
  describe("storage.buckets (bucket-name validation)", () => {
    it("rejects a bucket name Go's ValidateBucketName refuses", () => {
      const config = baseConfig({ storage: { buckets: { "bad/name": {} } } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid Bucket name: bad/name.",
      );
    });

    it("does not throw for a valid bucket name", () => {
      const config = baseConfig({ storage: { buckets: { "avatars.public": {} } } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw when no buckets are configured", () => {
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  // Go's Config.Validate rejects an invalid edge_runtime.deno_version
  // unconditionally — NOT gated on edge_runtime.enabled
  // (pkg/config/config.go:1164-1173).
  describe("edge_runtime.deno_version (required field in config)", () => {
    afterEach(() => {
      delete process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
    });

    it("rejects a configured deno_version of 0", () => {
      const config = baseConfig({ edge_runtime: { deno_version: 0 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: edge_runtime.deno_version",
      );
    });

    it.each([1, 2])("accepts the supported deno_version %d", (denoVersion) => {
      const config = baseConfig({ edge_runtime: { deno_version: denoVersion } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects an unsupported deno_version with the generic invalid-value message", () => {
      const config = baseConfig({ edge_runtime: { deno_version: 3 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Failed reading config: Invalid edge_runtime.deno_version: 3.",
      );
    });

    it("rejects a zero SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
      process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "0";
      const config = baseConfig({ edge_runtime: { deno_version: 2 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: edge_runtime.deno_version",
      );
    });

    it("rejects an unsupported SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
      process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "3";
      const config = baseConfig({ edge_runtime: { deno_version: 2 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Failed reading config: Invalid edge_runtime.deno_version: 3.",
      );
    });

    it("rejects a non-numeric SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
      process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "abc";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Failed reading config: Invalid edge_runtime.deno_version: abc.",
      );
    });

    it("treats an empty SUPABASE_EDGE_RUNTIME_DENO_VERSION override as unset, matching Viper's default", () => {
      process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "";
      const config = baseConfig({ edge_runtime: { deno_version: 2 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects an invalid deno_version even when edge_runtime is disabled", () => {
      const config = baseConfig({ edge_runtime: { enabled: false, deno_version: 0 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: edge_runtime.deno_version",
      );
    });
  });

  describe("analytics (BigQuery backend required fields)", () => {
    // Go's `Config.Validate` validates `[analytics]` right after
    // `edge_runtime.deno_version` (`pkg/config/config.go:1174-1187`): when
    // `analytics.enabled` and `analytics.backend == "bigquery"`, all three GCP
    // fields are required, checked in that order.
    afterEach(() => {
      delete process.env["SUPABASE_ANALYTICS_ENABLED"];
      delete process.env["SUPABASE_ANALYTICS_BACKEND"];
      delete process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"];
      delete process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"];
      delete process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"];
    });

    it("rejects an enabled bigquery backend without gcp_project_id", () => {
      const config = baseConfig({ analytics: { enabled: true, backend: "bigquery" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: analytics.gcp_project_id",
      );
    });

    it("rejects an enabled bigquery backend without gcp_project_number", () => {
      const config = baseConfig({
        analytics: { enabled: true, backend: "bigquery", gcp_project_id: "proj" },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: analytics.gcp_project_number",
      );
    });

    it("rejects an enabled bigquery backend without gcp_jwt_path", () => {
      const config = baseConfig({
        analytics: {
          enabled: true,
          backend: "bigquery",
          gcp_project_id: "proj",
          gcp_project_number: "123",
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Path to GCP Service Account Key must be provided in config, relative to config.toml: analytics.gcp_jwt_path",
      );
    });

    it("does not throw when an enabled bigquery backend has all three GCP fields", () => {
      const config = baseConfig({
        analytics: {
          enabled: true,
          backend: "bigquery",
          gcp_project_id: "proj",
          gcp_project_number: "123",
          gcp_jwt_path: "gcp.json",
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw for the postgres backend, however incomplete the GCP fields are", () => {
      const config = baseConfig({ analytics: { enabled: true, backend: "postgres" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw when analytics is disabled, however incomplete the GCP fields are", () => {
      const config = baseConfig({ analytics: { enabled: false, backend: "bigquery" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects a bigquery backend enabled only via SUPABASE_ANALYTICS_ENABLED", () => {
      process.env["SUPABASE_ANALYTICS_ENABLED"] = "true";
      const config = baseConfig({ analytics: { enabled: false, backend: "bigquery" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: analytics.gcp_project_id",
      );
    });

    it("rejects a bigquery backend selected only via SUPABASE_ANALYTICS_BACKEND", () => {
      process.env["SUPABASE_ANALYTICS_BACKEND"] = "bigquery";
      const config = baseConfig({ analytics: { enabled: true, backend: "postgres" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: analytics.gcp_project_id",
      );
    });

    it("accepts env-provided GCP fields overriding empty config.toml values", () => {
      process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"] = "proj";
      process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"] = "123";
      process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"] = "gcp.json";
      const config = baseConfig({ analytics: { enabled: true, backend: "bigquery" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("experimental.* (experimental.validate())", () => {
    // Go's `(e *experimental) validate()` (`pkg/config/config.go:1846-1854`),
    // called right after the analytics/bigquery block and right before
    // `Config.Validate` returns — unconditionally, no `enabled` gate of its own.
    //
    // The webhooks check hinges on whether `[experimental.webhooks]` is
    // PRESENT in config.toml, not the decoded `enabled` value — the shared
    // schema decode-fills `experimental.webhooks = { enabled: false }` even
    // when the section is entirely absent, so these tests pass the raw
    // `document` (the 5th param) to simulate what config.toml actually
    // contained, exactly like `LoadedProjectConfig.document` would.
    it("rejects a present [experimental.webhooks] section with enabled omitted", () => {
      const config = baseConfig({ experimental: { webhooks: {} } });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, {
          experimental: { webhooks: {} },
        }),
      ).toThrow(
        "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
      );
    });

    it("rejects a present [experimental.webhooks] section with enabled = false", () => {
      const config = baseConfig({ experimental: { webhooks: { enabled: false } } });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, {
          experimental: { webhooks: { enabled: false } },
        }),
      ).toThrow(
        "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
      );
    });

    it("does not throw when [experimental.webhooks] enabled = true", () => {
      const config = baseConfig({ experimental: { webhooks: { enabled: true } } });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, {
          experimental: { webhooks: { enabled: true } },
        }),
      ).not.toThrow();
    });

    it("does not throw when [experimental.webhooks] is absent entirely", () => {
      const config = baseConfig();
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, {}),
      ).not.toThrow();
    });

    it("does not throw a present [experimental.webhooks] section without enabled when no document is provided", () => {
      // No `document` (5th param) at all — e.g. a caller that hasn't threaded
      // `LoadedProjectConfig.document` through yet. The presence-only check
      // can't run without it, so it's skipped rather than guessed at; this
      // also covers every pre-existing call site/test in this file that
      // doesn't pass a 5th argument.
      const config = baseConfig({ experimental: { webhooks: {} } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects invalid JSON in experimental.pgdelta.format_options", () => {
      const config = baseConfig({ experimental: { pgdelta: { format_options: "{not json" } } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
      );
    });

    it("does not throw for valid JSON in experimental.pgdelta.format_options", () => {
      const config = baseConfig({
        experimental: { pgdelta: { format_options: '{"keywordCase":"upper"}' } },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw when experimental.pgdelta.format_options is unset", () => {
      const config = baseConfig({ experimental: { pgdelta: {} } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("SUPABASE_API_TLS_ENABLED env override", () => {
    // Go applies the Viper-bound `api.tls.enabled` override (config.go:582-586)
    // BEFORE deriving the default `api.external_url` scheme (config.go:799-809),
    // so an ambient/dotenv override flips http/https even when config.toml says
    // otherwise.
    afterEach(() => {
      delete process.env["SUPABASE_API_TLS_ENABLED"];
    });

    it("overrides api.tls.enabled from false to true", () => {
      process.env["SUPABASE_API_TLS_ENABLED"] = "true";
      const config = baseConfig({ api: { tls: { enabled: false }, port: 54321 } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("https://127.0.0.1:54321");
    });

    it("overrides api.tls.enabled from true to false", () => {
      process.env["SUPABASE_API_TLS_ENABLED"] = "false";
      const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("http://127.0.0.1:54321");
    });

    it("does not override api.tls.enabled once api.external_url is set", () => {
      process.env["SUPABASE_API_TLS_ENABLED"] = "true";
      const config = baseConfig({ api: { external_url: "http://config.example" } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("http://config.example");
    });

    it("rejects a malformed override instead of falling back to the configured value", () => {
      process.env["SUPABASE_API_TLS_ENABLED"] = "not-a-bool";
      const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        LegacyInvalidBoolEnvOverrideError,
      );
    });

    it("treats an empty override as unset, matching Viper's default", () => {
      process.env["SUPABASE_API_TLS_ENABLED"] = "";
      const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("https://127.0.0.1:54321");
    });
  });

  describe("auth.signing_keys_path (asymmetric JWT signing)", () => {
    const tempRoot = useLegacyTempWorkdir("supabase-signing-keys-test-");

    it("signs anon/service_role with the first RS256 key in the file", async () => {
      const jwk = generateRsaJwk();
      writeSigningKeys(tempRoot.current, [jwk]);
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);

      const publicJwk = { ...jwk, d: undefined, p: undefined, q: undefined, dp: undefined };
      const publicKey = await importJWK(publicJwk, "RS256");
      const { payload, protectedHeader } = await jwtVerify(values.anonKey, publicKey);
      expect(payload).toMatchObject({ iss: "supabase-demo", role: "anon" });
      expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "test-rsa-kid" });

      const serviceRole = await jwtVerify(values.serviceRoleKey, publicKey);
      expect(serviceRole.payload).toMatchObject({ role: "service_role" });
    });

    it("resolves a relative signing_keys_path against <workdir>/supabase", async () => {
      const jwk = generateRsaJwk();
      writeSigningKeys(tempRoot.current, [jwk]);
      const config = baseConfig({ auth: { signing_keys_path: "./signing_keys.json" } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
      expect(values.anonKey.split(".")).toHaveLength(3);
    });

    it("uses an absolute signing_keys_path as-is, without joining the workdir", async () => {
      const jwk = generateRsaJwk();
      writeSigningKeys(tempRoot.current, [jwk]);
      const absolutePath = join(tempRoot.current, "supabase", "signing_keys.json");
      const config = baseConfig({ auth: { signing_keys_path: absolutePath } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", "/some/unrelated/workdir");
      expect(values.anonKey.split(".")).toHaveLength(3);
    });

    it("still prefers an explicit anon_key/service_role_key over signing keys", () => {
      writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
      const config = baseConfig({
        auth: {
          signing_keys_path: "signing_keys.json",
          anon_key: "configured-anon",
          service_role_key: "configured-service-role",
        },
      });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
      expect(values.anonKey).toBe("configured-anon");
      expect(values.serviceRoleKey).toBe("configured-service-role");
    });

    it("falls back to HMAC signing when signing_keys_path resolves to an empty array", () => {
      writeSigningKeys(tempRoot.current, []);
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
      const [, payload] = values.anonKey.split(".");
      expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject({
        iss: "supabase-demo",
      });
    });

    it("throws a Go-worded error when the signing keys file does not exist", () => {
      const config = baseConfig({ auth: { signing_keys_path: "missing.json" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to read signing keys: ",
      );
    });

    it("throws a Go-worded error when the signing keys file is malformed JSON", () => {
      const supabaseDir = join(tempRoot.current, "supabase");
      mkdirSync(supabaseDir, { recursive: true });
      writeFileSync(join(supabaseDir, "signing_keys.json"), "not valid json");
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to decode signing keys: ",
      );
    });

    it("throws when the first key uses an unsupported algorithm", () => {
      writeSigningKeys(tempRoot.current, [{ ...generateRsaJwk(), alg: "RS512" }]);
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "unsupported algorithm: RS512",
      );
    });

    // Go's `Validate` only opens/parses `signing_keys_path` inside
    // `if c.Auth.Enabled` (`pkg/config/config.go:1036,1059-1065`) — a disabled
    // auth section never touches the file, however stale or missing it is.
    it("skips reading a missing signing_keys_path when auth is disabled", () => {
      const config = baseConfig({
        auth: { enabled: false, signing_keys_path: "missing.json" },
      });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });

    it("skips reading a malformed signing_keys_path when auth is disabled", () => {
      const supabaseDir = join(tempRoot.current, "supabase");
      mkdirSync(supabaseDir, { recursive: true });
      writeFileSync(join(supabaseDir, "signing_keys.json"), "not valid json");
      const config = baseConfig({
        auth: { enabled: false, signing_keys_path: "signing_keys.json" },
      });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
      // Falls back to HMAC signing, matching an absent signing key.
      const [, payload] = values.anonKey.split(".");
      expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject({
        iss: "supabase-demo",
      });
    });

    describe("SUPABASE_AUTH_ENABLED env override", () => {
      // `c.Auth.Enabled` is Viper-bound like any other field
      // (config.go:582-586), so `Validate`'s `if c.Auth.Enabled` gate
      // (config.go:1036,1059-1065) reads the POST-override value, not raw
      // TOML — a stale/missing signing_keys_path must be skipped when auth is
      // disabled only via env/dotenv, and read when auth is enabled only via
      // env/dotenv despite TOML saying otherwise.
      afterEach(() => {
        delete process.env["SUPABASE_AUTH_ENABLED"];
      });

      it("skips reading a missing signing_keys_path when auth is disabled only via env", () => {
        process.env["SUPABASE_AUTH_ENABLED"] = "false";
        const config = baseConfig({
          auth: { enabled: true, signing_keys_path: "missing.json" },
        });
        expect(() =>
          legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
        ).not.toThrow();
      });

      it("reads signing_keys_path when auth is enabled only via env despite TOML saying disabled", async () => {
        process.env["SUPABASE_AUTH_ENABLED"] = "true";
        const jwk = generateRsaJwk();
        writeSigningKeys(tempRoot.current, [jwk]);
        const config = baseConfig({
          auth: { enabled: false, signing_keys_path: "signing_keys.json" },
        });
        const values = legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
        expect(values.anonKey.split(".")).toHaveLength(3);
      });

      it("rejects a malformed override instead of falling back to the configured value", () => {
        process.env["SUPABASE_AUTH_ENABLED"] = "not-a-bool";
        const config = baseConfig({
          auth: { enabled: false, signing_keys_path: "missing.json" },
        });
        expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
          LegacyInvalidBoolEnvOverrideError,
        );
      });
    });
  });

  describe("auth.site_url (required field in config)", () => {
    it("rejects an explicit empty site_url when auth is enabled", () => {
      const config = baseConfig({ auth: { enabled: true, site_url: "" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: auth.site_url",
      );
    });

    it("does not throw when site_url is set and auth is enabled", () => {
      const config = baseConfig({ auth: { enabled: true, site_url: "http://localhost:3000" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    // Go's `Validate` nests this check inside `if c.Auth.Enabled`
    // (`pkg/config/config.go:1086-1090`) — a disabled auth section never
    // requires site_url, however empty it is.
    it("does not throw an explicit empty site_url when auth is disabled", () => {
      const config = baseConfig({ auth: { enabled: false, site_url: "" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    describe("SUPABASE_AUTH_ENABLED / SUPABASE_AUTH_SITE_URL env overrides", () => {
      afterEach(() => {
        delete process.env["SUPABASE_AUTH_ENABLED"];
        delete process.env["SUPABASE_AUTH_SITE_URL"];
      });

      it("rejects an empty site_url when auth is enabled only via env", () => {
        process.env["SUPABASE_AUTH_ENABLED"] = "true";
        const config = baseConfig({ auth: { enabled: false, site_url: "" } });
        expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: auth.site_url",
        );
      });

      it("does not throw when auth is disabled only via env, however empty site_url is", () => {
        process.env["SUPABASE_AUTH_ENABLED"] = "false";
        const config = baseConfig({ auth: { enabled: true, site_url: "" } });
        expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      it("accepts an env-provided site_url overriding an empty config.toml value", () => {
        process.env["SUPABASE_AUTH_SITE_URL"] = "http://localhost:4000";
        const config = baseConfig({ auth: { enabled: true, site_url: "" } });
        expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });
    });
  });

  describe("auth.captcha (required fields when enabled)", () => {
    // Go's `Config.Validate` checks `auth.captcha` right after `auth.site_url`,
    // still inside `if c.Auth.Enabled` (`pkg/config/config.go:1099-1109`).
    it("rejects an enabled captcha without a provider", () => {
      const config = baseConfig({
        auth: { enabled: true, site_url: "http://localhost:3000", captcha: { enabled: true } },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: auth.captcha.provider",
      );
    });

    it("rejects an enabled captcha with a provider but no secret", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          captcha: { enabled: true, provider: "hcaptcha" },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: auth.captcha.secret",
      );
    });

    it("does not throw when an enabled captcha has both provider and secret", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          captcha: { enabled: true, provider: "hcaptcha", secret: "shh" },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw when captcha is disabled, however incomplete", () => {
      const config = baseConfig({
        auth: { enabled: true, site_url: "http://localhost:3000", captcha: { enabled: false } },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    // A disabled auth section never requires captcha fields, however
    // incomplete the captcha config is.
    it("does not throw an enabled captcha without provider/secret when auth is disabled", () => {
      const config = baseConfig({
        auth: { enabled: false, captcha: { enabled: true } },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.hook.* (URI/secret validation when enabled)", () => {
    // Go's `Config.Validate` runs `Auth.Hook.validate()` right after signing
    // keys/passkey validation, still inside `if c.Auth.Enabled`
    // (`pkg/config/config.go:1136-1139`).
    it("rejects an enabled hook without a uri", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          hook: { custom_access_token: { enabled: true } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: auth.hook.custom_access_token.uri",
      );
    });

    it("rejects an http(s) hook uri without secrets", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          hook: {
            custom_access_token: { enabled: true, uri: "https://example.test/hook" },
          },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: auth.hook.custom_access_token.secrets",
      );
    });

    it("rejects an http(s) hook secret that doesn't match Go's hookSecretPattern", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          hook: {
            custom_access_token: {
              enabled: true,
              uri: "https://example.test/hook",
              secrets: "not-a-valid-secret",
            },
          },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        'auth.hook.custom_access_token.secrets must be formatted as "v1,whsec_<base64_encoded_secret>"',
      );
    });

    it("does not throw for a valid http(s) hook secret", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          hook: {
            custom_access_token: {
              enabled: true,
              uri: "https://example.test/hook",
              secrets: `v1,whsec_${"a".repeat(32)}`,
            },
          },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects a pg-functions hook uri with secrets set", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          hook: {
            custom_access_token: {
              enabled: true,
              uri: "pg-functions://postgres/public/hook",
              secrets: `v1,whsec_${"a".repeat(32)}`,
            },
          },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "auth.hook.custom_access_token.secrets is unsupported for pg-functions URI",
      );
    });

    it("does not throw for a pg-functions hook uri without secrets", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          hook: {
            custom_access_token: { enabled: true, uri: "pg-functions://postgres/public/hook" },
          },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects a hook uri with an unsupported scheme", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          hook: { custom_access_token: { enabled: true, uri: "ftp://example.test/hook" } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "auth.hook.custom_access_token.uri should be a HTTP, HTTPS, or pg-functions URI",
      );
    });

    it("does not throw for a disabled hook, however incomplete", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          hook: { custom_access_token: { enabled: false } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw an enabled hook without a uri when auth is disabled", () => {
      const config = baseConfig({
        auth: { enabled: false, hook: { custom_access_token: { enabled: true } } },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.mfa.* (enroll_enabled requires verify_enabled)", () => {
    // Go's `(m *mfa) validate()` (`pkg/config/config.go:1523-1534`), called right
    // after `Auth.Hook.validate()`, still inside `if c.Auth.Enabled`.
    it.each([
      ["totp", "auth.mfa.totp.enroll_enabled requires verify_enabled"],
      ["phone", "auth.mfa.phone.enroll_enabled requires verify_enabled"],
      ["web_authn", "auth.mfa.web_authn.enroll_enabled requires verify_enabled"],
    ] as const)("rejects %s enroll_enabled without verify_enabled", (factor, message) => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          mfa: { [factor]: { enroll_enabled: true, verify_enabled: false } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(message);
    });

    it("does not throw when enroll_enabled and verify_enabled are both true", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          mfa: { totp: { enroll_enabled: true, verify_enabled: true } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw an enroll_enabled MFA factor without verify_enabled when auth is disabled", () => {
      const config = baseConfig({
        auth: { enabled: false, mfa: { totp: { enroll_enabled: true, verify_enabled: false } } },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.third_party.* (thirdParty.validate())", () => {
    // Go's `(tpa *thirdParty) validate()` (`pkg/config/config.go:1635-1683`), called
    // right after `Auth.MFA.validate()`, still inside `if c.Auth.Enabled`.
    it("rejects firebase enabled without a project_id", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          third_party: { firebase: { enabled: true } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
      );
    });

    it("rejects auth0 enabled without a tenant", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          third_party: { auth0: { enabled: true } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config: auth.third_party.auth0 is enabled but without a tenant.",
      );
    });

    it("rejects aws_cognito enabled without a user_pool_id", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          third_party: { aws_cognito: { enabled: true } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config: auth.third_party.cognito is enabled but without a user_pool_id.",
      );
    });

    it("rejects aws_cognito enabled with a user_pool_id but no user_pool_region", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          third_party: { aws_cognito: { enabled: true, user_pool_id: "pool-1" } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.",
      );
    });

    it("rejects clerk enabled without a domain", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          third_party: { clerk: { enabled: true } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config: auth.third_party.clerk is enabled but without a domain.",
      );
    });

    it("rejects clerk enabled with a domain that doesn't match Go's clerkDomainPattern", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          third_party: { clerk: { enabled: true, domain: "not-a-clerk-domain" } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config: auth.third_party.clerk has invalid domain",
      );
    });

    it("does not throw for a valid clerk.example.com domain", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          third_party: { clerk: { enabled: true, domain: "clerk.example.com" } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects workos enabled without an issuer_url", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          third_party: { workos: { enabled: true } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config: auth.third_party.workos is enabled but without a issuer_url.",
      );
    });

    it("rejects more than one third_party provider enabled at once", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          third_party: {
            firebase: { enabled: true, project_id: "proj" },
            auth0: { enabled: true, tenant: "tenant" },
          },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config: Only one third_party provider allowed to be enabled at a time.",
      );
    });

    it("does not throw when no third_party provider is enabled", () => {
      const config = baseConfig({
        auth: { enabled: true, site_url: "http://localhost:3000" },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw an enabled third_party provider missing its required field when auth is disabled", () => {
      const config = baseConfig({
        auth: { enabled: false, third_party: { firebase: { enabled: true } } },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  // Go's Config.Validate runs ValidateFunctionSlug over every [functions.*] key
  // right after the auth block/generateAPIKeys, unconditionally — NOT gated on
  // auth.enabled (pkg/config/config.go:1155-1163).
  describe("functions.* (function-slug validation)", () => {
    it("rejects a function slug Go's ValidateFunctionSlug refuses", () => {
      const config = baseConfig({ functions: { "1bad": {} } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid Function name: 1bad.",
      );
    });

    it("does not throw for a valid function slug", () => {
      const config = baseConfig({ functions: { "hello-world_v2": {} } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw when no functions are configured", () => {
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects an invalid function slug even when auth is disabled", () => {
      const config = baseConfig({ auth: { enabled: false }, functions: { "1bad": {} } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid Function name: 1bad.",
      );
    });
  });

  describe("api.tls (cert/key validation)", () => {
    const tempRoot = useLegacyTempWorkdir("supabase-api-tls-test-");

    function writeTlsFile(workdir: string, name: string, contents = "dummy") {
      const supabaseDir = join(workdir, "supabase");
      mkdirSync(supabaseDir, { recursive: true });
      writeFileSync(join(supabaseDir, name), contents);
    }

    it("does not throw when tls.enabled with neither cert_path nor key_path set", () => {
      // Go's Validate only rejects the "exactly one set" case (config.go:1010-1027);
      // tls.enabled with nothing configured still loads.
      const config = baseConfig({ api: { tls: { enabled: true } } });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });

    it("rejects cert_path set without key_path", () => {
      writeTlsFile(tempRoot.current, "cert.pem");
      const config = baseConfig({ api: { tls: { enabled: true, cert_path: "cert.pem" } } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "Missing required field in config: api.tls.key_path",
      );
    });

    it("rejects key_path set without cert_path", () => {
      writeTlsFile(tempRoot.current, "key.pem");
      const config = baseConfig({ api: { tls: { enabled: true, key_path: "key.pem" } } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "Missing required field in config: api.tls.cert_path",
      );
    });

    it("throws a Go-worded error when the configured cert file does not exist", () => {
      writeTlsFile(tempRoot.current, "key.pem");
      const config = baseConfig({
        api: { tls: { enabled: true, cert_path: "missing-cert.pem", key_path: "key.pem" } },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to read TLS cert: ",
      );
    });

    it("throws a Go-worded error when the configured key file does not exist", () => {
      writeTlsFile(tempRoot.current, "cert.pem");
      const config = baseConfig({
        api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "missing-key.pem" } },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to read TLS key: ",
      );
    });

    it("succeeds when both cert_path and key_path are readable", () => {
      writeTlsFile(tempRoot.current, "cert.pem");
      writeTlsFile(tempRoot.current, "key.pem");
      const config = baseConfig({
        api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "key.pem" } },
      });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });

    it("resolves cert_path/key_path against <workdir>/supabase unconditionally, no isAbsolute guard", () => {
      // Go's `path.Join` (config.go:961-965) absorbs a leading "/" — unlike
      // signing_keys_path, which Go DOES guard with filepath.IsAbs.
      writeTlsFile(tempRoot.current, "cert.pem");
      writeTlsFile(tempRoot.current, "key.pem");
      const config = baseConfig({
        api: {
          tls: {
            enabled: true,
            cert_path: "/cert.pem",
            key_path: "/key.pem",
          },
        },
      });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });

    // Go's `Validate` nests the whole TLS branch inside `if c.Api.Enabled`
    // (config.go:1006,1010) — a disabled api section never validates cert/key,
    // however invalid the pairing.
    it("skips TLS validation entirely when api is disabled", () => {
      const config = baseConfig({
        api: { enabled: false, tls: { enabled: true, cert_path: "missing-cert.pem" } },
      });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });

    describe("SUPABASE_API_ENABLED / SUPABASE_API_TLS_ENABLED env overrides", () => {
      afterEach(() => {
        delete process.env["SUPABASE_API_ENABLED"];
        delete process.env["SUPABASE_API_TLS_ENABLED"];
      });

      it("skips TLS validation when api is disabled only via env", () => {
        process.env["SUPABASE_API_ENABLED"] = "false";
        const config = baseConfig({
          api: { enabled: true, tls: { enabled: true, cert_path: "missing-cert.pem" } },
        });
        expect(() =>
          legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
        ).not.toThrow();
      });

      it("validates TLS when enabled only via env despite TOML saying tls.enabled = false", () => {
        process.env["SUPABASE_API_TLS_ENABLED"] = "true";
        const config = baseConfig({
          api: { tls: { enabled: false, cert_path: "missing-cert.pem" } },
        });
        expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
          "Missing required field in config: api.tls.key_path",
        );
      });
    });
  });
});
