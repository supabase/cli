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
});
