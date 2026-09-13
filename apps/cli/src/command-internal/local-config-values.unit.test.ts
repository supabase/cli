import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { Schema } from "effect";
import { importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { DEFAULT_SIGNING_KEY } from "./go-jwt.ts";
import {
  POSTGRES_DEFAULT_ROOT_KEY,
  InvalidAnalyticsBackendEnvOverrideError,
  InvalidBoolEnvOverrideError,
  InvalidEdgeRuntimePolicyEnvOverrideError,
  InvalidJwtSecretError,
  InvalidPoolModeEnvOverrideError,
  InvalidPortEnvOverrideError,
  InvalidRealtimeIpVersionEnvOverrideError,
  InvalidSessionReplicationRoleEnvOverrideError,
  envOverrideApiMaxRows,
  envOverrideDefaultPoolSize,
  envOverrideEdgeRuntimePolicy,
  envOverrideMajorVersion,
  envOverrideMaxClientConn,
  envOverridePoolMode,
  envOverrideRealtimeIpVersion,
  envOverrideRealtimeMaxHeaderLength,
  rawUnmodeledBool,
  resolveAuthCaptcha,
  resolveAuthEmail,
  resolveAuthEmailSmtp,
  resolveAuthExternalProviders,
  resolveAuthExternalUrl,
  resolveAuthHooks,
  resolveAuthMfa,
  resolveAuthSms,
  resolveConfiguredSigningKeys,
  resolveDbSettingsEnvOverrides,
  resolveLocalConfigValues,
  resolveLocalJwks,
} from "./local-config-values.ts";

const decodeConfig = Schema.decodeUnknownSync(CliConfigSchema);
const WORKDIR = "/tmp/local-config-values-test";

function baseConfig(overrides: Record<string, unknown> = {}): CliConfig {
  return decodeConfig({ project_id: "test", ...overrides });
}

/** RSA JWK matching `JWK` struct field names (kty/n/e/d/p/q/dp/dq/qi). */
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

describe("resolveLocalConfigValues", () => {
  it("derives every URL from api.external_url when unset", () => {
    const config = baseConfig();
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);

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
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.apiUrl).toBe("https://127.0.0.1:54321");
  });

  it("uses api.external_url verbatim when configured", () => {
    const config = baseConfig({ api: { external_url: "https://example.test" } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.apiUrl).toBe("https://example.test");
    expect(values.restUrl).toBe("https://example.test/rest/v1");
  });

  it("brackets an IPv6 hostname when building host:port", () => {
    const config = baseConfig();
    const values = resolveLocalConfigValues(config, "::1", WORKDIR);
    expect(values.apiUrl).toBe("http://[::1]:54321");
  });

  it("builds the db URL with the hardcoded postgres password", () => {
    const config = baseConfig({ db: { port: 54322 } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  });

  it("falls back to the default JWT secret and opaque keys when unset", () => {
    const config = baseConfig();
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.jwtSecret).toBe("super-secret-jwt-token-with-at-least-32-characters-long");
    expect(values.publishableKey).toBe("sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH");
    expect(values.secretKey).toBe("sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz");
  });

  it("uses configured opaque keys verbatim when set", () => {
    const config = baseConfig({
      auth: { publishable_key: "sb_publishable_custom", secret_key: "sb_secret_custom" },
    });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.publishableKey).toBe("sb_publishable_custom");
    expect(values.secretKey).toBe("sb_secret_custom");
  });

  it("signs the default anon/service_role JWTs from the resolved secret", () => {
    const config = baseConfig();
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
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
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.anonKey).toBe("configured-anon");
    expect(values.serviceRoleKey).toBe("configured-service-role");
  });

  it("signs anon/service_role JWTs from a configured jwt_secret", () => {
    const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.jwtSecret).toBe("a".repeat(32));
    expect(values.anonKey).not.toBe("");
  });

  it("rejects a configured jwt_secret shorter than 16 characters", () => {
    const config = baseConfig({ auth: { jwt_secret: "a".repeat(15) } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      InvalidJwtSecretError,
    );
  });

  describe("encrypted auth secrets", () => {
    // This ciphertext decrypts to "value" under the keypair below.
    const VAULT_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
    const VAULT_ENCRYPTED =
      "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

    afterEach(() => {
      delete process.env["DOTENV_PRIVATE_KEY"];
    });

    it("decrypts an encrypted: jwt_secret when DOTENV_PRIVATE_KEY is set", () => {
      process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
      const config = baseConfig({ auth: { jwt_secret: VAULT_ENCRYPTED } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        InvalidJwtSecretError,
      );
    });

    it("decrypts an encrypted: publishable_key when DOTENV_PRIVATE_KEY is set", () => {
      process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
      const config = baseConfig({ auth: { publishable_key: VAULT_ENCRYPTED } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.publishableKey).toBe("value");
    });

    it("fails config loading for an encrypted: secret with no private key, matching Go", () => {
      const config = baseConfig({ auth: { publishable_key: VAULT_ENCRYPTED } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "failed to parse config: missing private key",
      );
    });

    it("decrypts an encrypted: auth.email.smtp.pass, matching Go's Secret-typed Smtp.Pass field", () => {
      process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
      const document = { auth: { email: { smtp: { enabled: true, pass: VAULT_ENCRYPTED } } } };
      const resolved = resolveAuthEmailSmtp(document.auth, undefined);
      expect(resolved?.pass).toBe("value");
    });

    it("decrypts an encrypted: studio.openai_api_key, matching Go's Secret-typed OpenaiApiKey field", () => {
      process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
      const config = baseConfig({ studio: { openai_api_key: VAULT_ENCRYPTED } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.openaiApiKey).toBe("value");
    });

    it("decrypts an encrypted: SUPABASE_AUTH_* env override, not just the config.toml value", () => {
      process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
      const config = baseConfig();
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, {
        SUPABASE_AUTH_SECRET_KEY: VAULT_ENCRYPTED,
      });
      expect(values.secretKey).toBe("value");
      delete process.env["DOTENV_PRIVATE_KEY"];
    });
  });

  it("rejects an explicit empty project_id, matching Go's Config.Validate", () => {
    // An explicit `project_id = ""` overwrites the workdir-basename default with the literal
    // empty string, unlike an absent key.
    const config = baseConfig({ project_id: "" });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "Missing required field in config: project_id",
    );
  });

  it("does not reject an absent project_id when the workdir basename sanitizes to a non-empty value", () => {
    const config = Schema.decodeUnknownSync(CliConfigSchema)({});
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
  });

  it("rejects an absent project_id when the workdir basename sanitizes to empty, matching Go", () => {
    // The workdir-basename default still applies with no `project_id` key present, so a workdir
    // whose basename sanitizes to empty (e.g. `!!!`) still fails validation.
    const config = Schema.decodeUnknownSync(CliConfigSchema)({});
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", "/tmp/!!!")).toThrow(
      "Missing required field in config: project_id",
    );
  });

  it("lets SUPABASE_PROJECT_ID override an absent project_id whose basename sanitizes to empty", () => {
    const config = Schema.decodeUnknownSync(CliConfigSchema)({});
    expect(() =>
      resolveLocalConfigValues(config, "127.0.0.1", "/tmp/!!!", {
        SUPABASE_PROJECT_ID: "env-project",
      }),
    ).not.toThrow();
  });

  it("lets SUPABASE_PROJECT_ID override an explicit empty project_id", () => {
    const config = baseConfig({ project_id: "" });
    expect(() =>
      resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, {
        SUPABASE_PROJECT_ID: "env-project",
      }),
    ).not.toThrow();
  });

  it("hardcodes the Go-parity local S3 credentials", () => {
    const config = baseConfig();
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.storageS3AccessKeyId).toBe("625729a08b95bf1b7ff351a663f3a23c");
    expect(values.storageS3SecretAccessKey).toBe(
      "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
    );
    expect(values.storageS3Region).toBe("local");
  });

  describe("SUPABASE_AUTH_* env overrides", () => {
    const tempRoot = useTempWorkdir("supabase-signing-keys-env-override-test-");

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
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.jwtSecret).toBe("b".repeat(32));
    });

    it("overrides publishable_key/secret_key", () => {
      process.env["SUPABASE_AUTH_PUBLISHABLE_KEY"] = "env-publishable";
      process.env["SUPABASE_AUTH_SECRET_KEY"] = "env-secret";
      const config = baseConfig({
        auth: { publishable_key: "config-publishable", secret_key: "config-secret" },
      });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.publishableKey).toBe("env-publishable");
      expect(values.secretKey).toBe("env-secret");
    });

    it("overrides anon_key/service_role_key", () => {
      process.env["SUPABASE_AUTH_ANON_KEY"] = "env-anon";
      process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"] = "env-service-role";
      const config = baseConfig({
        auth: { anon_key: "config-anon", service_role_key: "config-service-role" },
      });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.anonKey).toBe("env-anon");
      expect(values.serviceRoleKey).toBe("env-service-role");
    });

    it("treats an empty env var as unset, matching Viper's default", () => {
      process.env["SUPABASE_AUTH_JWT_SECRET"] = "";
      const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.jwtSecret).toBe("a".repeat(32));
    });

    it("still applies the short-secret validation to an env-provided jwt_secret", () => {
      process.env["SUPABASE_AUTH_JWT_SECRET"] = "too-short";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        InvalidJwtSecretError,
      );
    });

    it("overrides signing_keys_path even when config.toml doesn't set one", async () => {
      const jwk = generateRsaJwk();
      writeSigningKeys(tempRoot.current, [jwk]);
      process.env["SUPABASE_AUTH_SIGNING_KEYS_PATH"] = "signing_keys.json";
      const config = baseConfig();
      const values = resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);

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
      const values = resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
      const [header] = values.anonKey.split(".");
      expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toMatchObject({
        kid: "env-kid",
      });
    });
  });

  describe("SUPABASE_* env(VAR) indirection (Go's LoadEnvHook)", () => {
    // `env(VAR)` indirection resolves inside any string field, including a `SUPABASE_*` override
    // value itself, not just a config.toml literal.
    const ENV_KEYS = ["SUPABASE_AUTH_JWT_SECRET", "SUPABASE_DB_PORT", "SUPABASE_API_ENABLED"];

    afterEach(() => {
      for (const key of ENV_KEYS) delete process.env[key];
      delete process.env["INDIRECT_JWT_SECRET"];
      delete process.env["INDIRECT_DB_PORT"];
      delete process.env["INDIRECT_API_ENABLED"];
    });

    it("resolves a string override's env(VAR) indirection", () => {
      process.env["SUPABASE_AUTH_JWT_SECRET"] = "env(INDIRECT_JWT_SECRET)";
      process.env["INDIRECT_JWT_SECRET"] = "c".repeat(32);
      const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.jwtSecret).toBe("c".repeat(32));
    });

    it("resolves a port override's env(VAR) indirection", () => {
      process.env["SUPABASE_DB_PORT"] = "env(INDIRECT_DB_PORT)";
      process.env["INDIRECT_DB_PORT"] = "54329";
      const config = baseConfig({ db: { port: 54322 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54329/postgres");
    });

    it("resolves a bool override's env(VAR) indirection", () => {
      process.env["SUPABASE_API_ENABLED"] = "env(INDIRECT_API_ENABLED)";
      process.env["INDIRECT_API_ENABLED"] = "false";
      const config = baseConfig({
        api: { enabled: true, tls: { enabled: true, cert_path: "missing-cert.pem" } },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("preserves the env(VAR) literal when the indirected var is unset, matching Go", () => {
      process.env["SUPABASE_AUTH_JWT_SECRET"] = "env(INDIRECT_JWT_SECRET)";
      const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.jwtSecret).toBe("env(INDIRECT_JWT_SECRET)");
    });
  });

  describe("non-auth SUPABASE_* env overrides", () => {
    const ENV_KEYS = [
      "SUPABASE_DB_PORT",
      "SUPABASE_STUDIO_PORT",
      "SUPABASE_LOCAL_SMTP_PORT",
      "SUPABASE_API_PORT",
      "SUPABASE_API_EXTERNAL_URL",
      "SUPABASE_STUDIO_API_URL",
    ] as const;

    afterEach(() => {
      for (const key of ENV_KEYS) delete process.env[key];
    });

    it("overrides db.port for the derived DB URL and the exposed dbPort", () => {
      process.env["SUPABASE_DB_PORT"] = "54329";
      const config = baseConfig({ db: { port: 54322 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54329/postgres");
      expect(values.dbPort).toBe(54329);
    });

    it("overrides studio.port for the derived Studio URL", () => {
      process.env["SUPABASE_STUDIO_PORT"] = "54330";
      const config = baseConfig({ studio: { port: 54323 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.studioUrl).toBe("http://127.0.0.1:54330");
    });

    it("overrides local_smtp.port for the derived Mailpit URL", () => {
      process.env["SUPABASE_LOCAL_SMTP_PORT"] = "54331";
      const config = baseConfig({ local_smtp: { port: 54324 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.mailpitUrl).toBe("http://127.0.0.1:54331");
    });

    it("overrides api.port for every API-derived URL", () => {
      process.env["SUPABASE_API_PORT"] = "54332";
      const config = baseConfig({ api: { port: 54321 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("http://127.0.0.1:54332");
      expect(values.restUrl).toBe("http://127.0.0.1:54332/rest/v1");
    });

    it("overrides api.external_url even when config.toml sets one", () => {
      process.env["SUPABASE_API_EXTERNAL_URL"] = "https://env-override.example";
      const config = baseConfig({ api: { external_url: "https://config.example" } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("https://env-override.example");
    });

    it("treats an empty non-auth env var as unset, matching Viper's default", () => {
      process.env["SUPABASE_DB_PORT"] = "";
      const config = baseConfig({ db: { port: 54322 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    });

    it.each([
      "SUPABASE_DB_PORT",
      "SUPABASE_STUDIO_PORT",
      "SUPABASE_LOCAL_SMTP_PORT",
      "SUPABASE_API_PORT",
    ] as const)("rejects a malformed %s override instead of producing NaN", (envKey) => {
      process.env[envKey] = "abc";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        InvalidPortEnvOverrideError,
      );
    });

    it("rejects a SUPABASE_DB_PORT override above the uint16 range", () => {
      process.env["SUPABASE_DB_PORT"] = "99999";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        InvalidPortEnvOverrideError,
      );
    });

    it("resolves an octal leading-zero SUPABASE_DB_PORT override to its octal value, not decimal", () => {
      process.env["SUPABASE_DB_PORT"] = "010";
      const config = baseConfig({ db: { port: 54322 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.dbPort).toBe(8);
      expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:8/postgres");
    });

    it("resolves a 0x-prefixed SUPABASE_DB_PORT override as hex", () => {
      process.env["SUPABASE_DB_PORT"] = "0x1F90";
      const config = baseConfig({ db: { port: 54322 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.dbPort).toBe(8080);
    });

    it("still resolves a plain decimal SUPABASE_DB_PORT override with no leading zero", () => {
      process.env["SUPABASE_DB_PORT"] = "5432";
      const config = baseConfig({ db: { port: 54322 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.dbPort).toBe(5432);
    });

    it("rejects a 0x-prefixed SUPABASE_DB_PORT override exceeding the uint16 range", () => {
      process.env["SUPABASE_DB_PORT"] = "0x1FFFF";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        InvalidPortEnvOverrideError,
      );
    });

    // Unlike the malformed/out-of-range cases above, db.port=0 is a required-field failure with
    // no `enabled` gate, unlike api.port/studio.port/local_smtp.port.
    it("rejects a zero SUPABASE_DB_PORT override, matching Go's required-field check", () => {
      process.env["SUPABASE_DB_PORT"] = "0";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: db.port",
      );
    });

    // api.enabled defaults to true, so this rejection applies without an explicit
    // `api.enabled = true`.
    it("rejects a configured api.port of 0 when api is enabled", () => {
      const config = baseConfig({ api: { port: 0 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: api.port",
      );
    });

    it("rejects a zero SUPABASE_API_PORT override when api is enabled", () => {
      process.env["SUPABASE_API_PORT"] = "0";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: api.port",
      );
    });

    it("does not reject a zero api.port when api is disabled", () => {
      const config = baseConfig({ api: { enabled: false, port: 0 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    // studio.enabled defaults to true, so this rejection applies without an explicit
    // `studio.enabled = true`.
    it("rejects a configured studio.port of 0 when studio is enabled", () => {
      const config = baseConfig({ studio: { port: 0 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: studio.port",
      );
    });

    it("rejects a zero SUPABASE_STUDIO_PORT override when studio is enabled", () => {
      process.env["SUPABASE_STUDIO_PORT"] = "0";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: studio.port",
      );
    });

    it("does not reject a zero studio.port when studio is disabled", () => {
      const config = baseConfig({ studio: { enabled: false, port: 0 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects a malformed studio.api_url (unterminated IPv6 literal) when studio is enabled", () => {
      const config = baseConfig({ studio: { api_url: "http://[::1" } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        `Invalid config for studio.api_url: parse "http://[::1": missing ']' in host`,
      );
    });

    it("does not reject a malformed studio.api_url when studio is disabled", () => {
      const config = baseConfig({ studio: { enabled: false, api_url: "http://[::1" } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw for the default studio.api_url", () => {
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects a malformed SUPABASE_STUDIO_API_URL override", () => {
      process.env["SUPABASE_STUDIO_API_URL"] = "http://[::1";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        `Invalid config for studio.api_url: parse "http://[::1": missing ']' in host`,
      );
    });

    // local_smtp.enabled defaults to true, so this rejection applies without an explicit
    // `local_smtp.enabled = true`.
    it("rejects a configured local_smtp.port of 0 when local_smtp is enabled", () => {
      const config = baseConfig({ local_smtp: { port: 0 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: local_smtp.port",
      );
    });

    it("rejects a zero SUPABASE_LOCAL_SMTP_PORT override when local_smtp is enabled", () => {
      process.env["SUPABASE_LOCAL_SMTP_PORT"] = "0";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: local_smtp.port",
      );
    });

    it("does not reject a zero local_smtp.port when local_smtp is disabled", () => {
      const config = baseConfig({ local_smtp: { enabled: false, port: 0 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("db.major_version (required field in config)", () => {
    // Required-field/range assertions live in config-validate.unit.test.ts; only env-override
    // mechanics are tested here.
    afterEach(() => {
      delete process.env["SUPABASE_DB_MAJOR_VERSION"];
    });

    it("overrides a valid configured major_version via SUPABASE_DB_MAJOR_VERSION", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "15";
      const config = baseConfig({ db: { major_version: 17 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects an unsupported SUPABASE_DB_MAJOR_VERSION override", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "16";
      const config = baseConfig({ db: { major_version: 17 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Failed reading config: Invalid db.major_version: 16.",
      );
    });

    it("rejects a non-numeric SUPABASE_DB_MAJOR_VERSION override", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "abc";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Failed reading config: Invalid db.major_version: abc.",
      );
    });

    it("treats an empty SUPABASE_DB_MAJOR_VERSION override as unset, matching Viper's default", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "";
      const config = baseConfig({ db: { major_version: 17 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED env override", () => {
    // Always validated eagerly, with no presence/enabled gate — same bucket as
    // db.port/db.major_version above.
    afterEach(() => {
      delete process.env["SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED"];
    });

    it("does not throw for a valid SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED override", () => {
      process.env["SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects a malformed SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED override", () => {
      process.env["SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED"] = "notabool";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        InvalidBoolEnvOverrideError,
      );
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        'Invalid config for db.network_restrictions.enabled: cannot parse "notabool" as a bool',
      );
    });
  });

  describe("db.root_key (unmodeled raw-document field)", () => {
    it("falls back to the default root key when absent", () => {
      const config = baseConfig();
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.rootKey).toBe(POSTGRES_DEFAULT_ROOT_KEY);
    });

    it("uses a configured string root_key verbatim", () => {
      const config = baseConfig();
      const document = { db: { root_key: "custom-root-key" } };
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document);
      expect(values.rootKey).toBe("custom-root-key");
    });

    it("rejects a non-string root_key (e.g. a bare TOML integer), matching Go's Secret decode failure", () => {
      const config = baseConfig();
      const document = { db: { root_key: 12345 } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow(
        "failed to parse config: decoding failed due to the following error(s):\n\n'db.root_key' expected a map or struct",
      );
    });
  });

  // storage.buckets validation lives entirely in config-validate.unit.test.ts; this file has no
  // bucket-related mechanics of its own.

  // Not gated on edge_runtime.enabled — an invalid value is rejected unconditionally.
  describe("edge_runtime.deno_version (required field in config)", () => {
    // Required-field/range assertions live in config-validate.unit.test.ts; only env-override
    // mechanics are tested here.
    afterEach(() => {
      delete process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
    });

    it("rejects a zero SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
      process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "0";
      const config = baseConfig({ edge_runtime: { deno_version: 2 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: edge_runtime.deno_version",
      );
    });

    it("rejects an unsupported SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
      process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "3";
      const config = baseConfig({ edge_runtime: { deno_version: 2 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Failed reading config: Invalid edge_runtime.deno_version: 3.",
      );
    });

    it("rejects a non-numeric SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
      process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "abc";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Failed reading config: Invalid edge_runtime.deno_version: abc.",
      );
    });

    it("treats an empty SUPABASE_EDGE_RUNTIME_DENO_VERSION override as unset, matching Viper's default", () => {
      process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "";
      const config = baseConfig({ edge_runtime: { deno_version: 2 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("analytics (BigQuery backend required fields)", () => {
    // Required-field/range assertions live in config-validate.unit.test.ts; only env-override
    // mechanics are tested here.
    afterEach(() => {
      delete process.env["SUPABASE_ANALYTICS_ENABLED"];
      delete process.env["SUPABASE_ANALYTICS_BACKEND"];
      delete process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"];
      delete process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"];
      delete process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"];
    });

    it("rejects a bigquery backend enabled only via SUPABASE_ANALYTICS_ENABLED", () => {
      process.env["SUPABASE_ANALYTICS_ENABLED"] = "true";
      const config = baseConfig({ analytics: { enabled: false, backend: "bigquery" } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: analytics.gcp_project_id",
      );
    });

    it("rejects a bigquery backend selected only via SUPABASE_ANALYTICS_BACKEND", () => {
      process.env["SUPABASE_ANALYTICS_BACKEND"] = "bigquery";
      const config = baseConfig({ analytics: { enabled: true, backend: "postgres" } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: analytics.gcp_project_id",
      );
    });

    it("accepts env-provided GCP fields overriding empty config.toml values", () => {
      process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"] = "proj";
      process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"] = "123";
      process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"] = "gcp.json";
      const config = baseConfig({ analytics: { enabled: true, backend: "bigquery" } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects an invalid SUPABASE_ANALYTICS_BACKEND override", () => {
      process.env["SUPABASE_ANALYTICS_BACKEND"] = "mysql";
      const config = baseConfig({ analytics: { enabled: true, backend: "postgres" } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        InvalidAnalyticsBackendEnvOverrideError,
      );
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        'Invalid config for analytics.backend: cannot parse "mysql" as one of "postgres", "bigquery"',
      );
    });
  });

  describe("experimental.* (experimental.validate())", () => {
    // Exercises this function's own fallback when no `document` (5th param) is supplied; the
    // required-field/enabled checks themselves live in config-validate.unit.test.ts.
    it("does not throw a present [experimental.webhooks] section without enabled when no document is provided", () => {
      const config = baseConfig({ experimental: { webhooks: {} } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    // Required-field/range assertions live in config-validate.unit.test.ts; only env-override
    // mechanics are tested here.
    afterEach(() => {
      delete process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"];
      delete process.env["SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS"];
    });

    it("enables webhooks purely via SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED when the section omits enabled", () => {
      process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"] = "true";
      const config = baseConfig({ experimental: { webhooks: {} } });
      const document = { experimental: { webhooks: {} } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("rejects a malformed SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED override on an already-enabled section", () => {
      process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"] = "notabool";
      const config = baseConfig({ experimental: { webhooks: { enabled: true } } });
      const document = { experimental: { webhooks: { enabled: true } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow(InvalidBoolEnvOverrideError);
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow(
        'Invalid config for experimental.webhooks.enabled: cannot parse "notabool" as a bool',
      );
    });

    it("rejects an invalid JSON SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS override", () => {
      process.env["SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS"] = "{not valid json";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
      );
    });

    it("accepts a valid JSON SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS override", () => {
      process.env["SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS"] = '{"keywordCase":"upper"}';
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("suppresses a malformed SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS when a remote block already set experimental.pgdelta.format_options (review: PRRT_kwDOErm0O86XLe6o)", () => {
      process.env["SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS"] = "{not valid json";
      const config = baseConfig({
        experimental: { pgdelta: { format_options: '{"keywordCase":"upper"}' } },
      });
      expect(() =>
        resolveLocalConfigValues(
          config,
          "127.0.0.1",
          WORKDIR,
          undefined,
          undefined,
          new Set(["experimental.pgdelta.format_options"]),
        ),
      ).not.toThrow();
    });
  });

  describe("SUPABASE_API_TLS_ENABLED env override", () => {
    // Applied before the default `api.external_url` scheme is derived, so it can flip http/https
    // even when config.toml disagrees.
    afterEach(() => {
      delete process.env["SUPABASE_API_TLS_ENABLED"];
    });

    it("overrides api.tls.enabled from false to true", () => {
      process.env["SUPABASE_API_TLS_ENABLED"] = "true";
      const config = baseConfig({ api: { tls: { enabled: false }, port: 54321 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("https://127.0.0.1:54321");
    });

    it("overrides api.tls.enabled from true to false", () => {
      process.env["SUPABASE_API_TLS_ENABLED"] = "false";
      const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("http://127.0.0.1:54321");
    });

    it("does not override api.tls.enabled once api.external_url is set", () => {
      process.env["SUPABASE_API_TLS_ENABLED"] = "true";
      const config = baseConfig({ api: { external_url: "http://config.example" } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("http://config.example");
    });

    it("rejects a malformed override instead of falling back to the configured value", () => {
      process.env["SUPABASE_API_TLS_ENABLED"] = "not-a-bool";
      const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        InvalidBoolEnvOverrideError,
      );
    });

    it("treats an empty override as unset, matching Viper's default", () => {
      process.env["SUPABASE_API_TLS_ENABLED"] = "";
      const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("https://127.0.0.1:54321");
    });
  });

  describe("envOverrideRealtimeIpVersion", () => {
    afterEach(() => {
      delete process.env["SUPABASE_REALTIME_IP_VERSION"];
    });

    it("falls back to the configured value when unset", () => {
      expect(envOverrideRealtimeIpVersion("IPv4", undefined)).toBe("IPv4");
    });

    it("overrides IPv4 to IPv6 via the env var", () => {
      process.env["SUPABASE_REALTIME_IP_VERSION"] = "IPv6";
      expect(envOverrideRealtimeIpVersion("IPv4", undefined)).toBe("IPv6");
    });

    it("rejects an invalid override instead of falling back to the configured value", () => {
      process.env["SUPABASE_REALTIME_IP_VERSION"] = "IPv5";
      expect(() => envOverrideRealtimeIpVersion("IPv4", undefined)).toThrow(
        InvalidRealtimeIpVersionEnvOverrideError,
      );
      expect(() => envOverrideRealtimeIpVersion("IPv4", undefined)).toThrow(
        'Invalid config for realtime.ip_version: cannot parse "IPv5" as one of "IPv4", "IPv6"',
      );
    });
  });

  describe("envOverrideRealtimeMaxHeaderLength", () => {
    afterEach(() => {
      delete process.env["SUPABASE_REALTIME_MAX_HEADER_LENGTH"];
    });

    it("falls back to the configured value when unset", () => {
      expect(envOverrideRealtimeMaxHeaderLength(4096, undefined)).toBe(4096);
    });

    it("overrides the configured value via the env var", () => {
      process.env["SUPABASE_REALTIME_MAX_HEADER_LENGTH"] = "8192";
      expect(envOverrideRealtimeMaxHeaderLength(4096, undefined)).toBe(8192);
    });

    it("also honors a projectEnvValues (dotenv) value", () => {
      expect(
        envOverrideRealtimeMaxHeaderLength(4096, {
          SUPABASE_REALTIME_MAX_HEADER_LENGTH: "16384",
        }),
      ).toBe(16384);
    });

    it("rejects an override exceeding the uint64 max (2^64), matching Go's ParseUint failure", () => {
      process.env["SUPABASE_REALTIME_MAX_HEADER_LENGTH"] = "18446744073709551616";
      expect(() => envOverrideRealtimeMaxHeaderLength(4096, undefined)).toThrow(
        "Failed reading config: Invalid realtime.max_header_length: 18446744073709551616.",
      );
    });

    it("accepts an override of exactly the uint64 max (2^64-1)", () => {
      process.env["SUPABASE_REALTIME_MAX_HEADER_LENGTH"] = "18446744073709551615";
      expect(() => envOverrideRealtimeMaxHeaderLength(4096, undefined)).not.toThrow();
    });

    it("rejects a hex override exceeding the uint64 max (2^64), matching Go's ParseUint failure", () => {
      process.env["SUPABASE_REALTIME_MAX_HEADER_LENGTH"] = "0x10000000000000000";
      expect(() => envOverrideRealtimeMaxHeaderLength(4096, undefined)).toThrow(
        "Failed reading config: Invalid realtime.max_header_length: 0x10000000000000000.",
      );
    });
  });

  describe("envOverrideApiMaxRows", () => {
    afterEach(() => {
      delete process.env["SUPABASE_API_MAX_ROWS"];
    });

    it("falls back to the configured value when unset", () => {
      expect(envOverrideApiMaxRows(1000, undefined)).toBe(1000);
    });

    it("overrides the configured value via the env var", () => {
      process.env["SUPABASE_API_MAX_ROWS"] = "500";
      expect(envOverrideApiMaxRows(1000, undefined)).toBe(500);
    });
  });

  // Exercises `envOverrideMajorVersion`'s base-0 parsing directly; most literals below don't
  // correspond to a supported Postgres major version, which the full pipeline would separately
  // reject.
  describe("envOverrideMajorVersion", () => {
    afterEach(() => {
      delete process.env["SUPABASE_DB_MAJOR_VERSION"];
    });

    it("falls back to the configured value when unset", () => {
      expect(envOverrideMajorVersion(17, undefined)).toBe(17);
    });

    it("resolves an octal leading-zero override to its octal value, not decimal", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "010";
      expect(envOverrideMajorVersion(17, undefined)).toBe(8);
    });

    it("resolves a 0x-prefixed override as hex", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "0x10";
      expect(envOverrideMajorVersion(17, undefined)).toBe(16);
    });

    it("resolves a 0b-prefixed override as binary", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "0b101";
      expect(envOverrideMajorVersion(17, undefined)).toBe(5);
    });

    it("still resolves a plain decimal override with no leading zero", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "15";
      expect(envOverrideMajorVersion(17, undefined)).toBe(15);
    });

    it("permits an underscore digit separator between decimal digits", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "1_000";
      expect(envOverrideMajorVersion(17, undefined)).toBe(1000);
    });

    it("rejects an invalid octal digit instead of silently falling back to decimal", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "08";
      expect(() => envOverrideMajorVersion(17, undefined)).toThrow(
        "Failed reading config: Invalid db.major_version: 08.",
      );
    });

    it("rejects a signed override", () => {
      process.env["SUPABASE_DB_MAJOR_VERSION"] = "+5";
      expect(() => envOverrideMajorVersion(17, undefined)).toThrow(
        "Failed reading config: Invalid db.major_version: +5.",
      );
    });
  });

  describe("envOverridePoolMode", () => {
    afterEach(() => {
      delete process.env["SUPABASE_DB_POOLER_POOL_MODE"];
    });

    it("falls back to the configured value when unset", () => {
      expect(envOverridePoolMode("transaction", undefined)).toBe("transaction");
    });

    it("overrides the configured value via the env var", () => {
      process.env["SUPABASE_DB_POOLER_POOL_MODE"] = "session";
      expect(envOverridePoolMode("transaction", undefined)).toBe("session");
    });

    it("rejects an invalid override instead of falling back to the configured value", () => {
      process.env["SUPABASE_DB_POOLER_POOL_MODE"] = "invalid";
      expect(() => envOverridePoolMode("transaction", undefined)).toThrow(
        InvalidPoolModeEnvOverrideError,
      );
      expect(() => envOverridePoolMode("transaction", undefined)).toThrow(
        'Invalid config for db.pooler.pool_mode: cannot parse "invalid" as one of "transaction", "session"',
      );
    });
  });

  describe("envOverrideEdgeRuntimePolicy", () => {
    afterEach(() => {
      delete process.env["SUPABASE_EDGE_RUNTIME_POLICY"];
    });

    it("falls back to the configured value when unset", () => {
      expect(envOverrideEdgeRuntimePolicy("oneshot", undefined)).toBe("oneshot");
    });

    it("overrides the configured value via the env var", () => {
      process.env["SUPABASE_EDGE_RUNTIME_POLICY"] = "per_worker";
      expect(envOverrideEdgeRuntimePolicy("oneshot", undefined)).toBe("per_worker");
    });

    it("rejects an invalid override instead of falling back to the configured value", () => {
      process.env["SUPABASE_EDGE_RUNTIME_POLICY"] = "invalid";
      expect(() => envOverrideEdgeRuntimePolicy("oneshot", undefined)).toThrow(
        InvalidEdgeRuntimePolicyEnvOverrideError,
      );
      expect(() => envOverrideEdgeRuntimePolicy("oneshot", undefined)).toThrow(
        'Invalid config for edge_runtime.policy: cannot parse "invalid" as one of "per_worker", "oneshot"',
      );
    });
  });

  describe("envOverrideDefaultPoolSize", () => {
    afterEach(() => {
      delete process.env["SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE"];
    });

    it("falls back to the configured value when unset", () => {
      expect(envOverrideDefaultPoolSize(20, undefined)).toBe(20);
    });

    it("overrides the configured value via the env var", () => {
      process.env["SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE"] = "40";
      expect(envOverrideDefaultPoolSize(20, undefined)).toBe(40);
    });
  });

  describe("envOverrideMaxClientConn", () => {
    afterEach(() => {
      delete process.env["SUPABASE_DB_POOLER_MAX_CLIENT_CONN"];
    });

    it("falls back to the configured value when unset", () => {
      expect(envOverrideMaxClientConn(100, undefined)).toBe(100);
    });

    it("overrides the configured value via the env var", () => {
      process.env["SUPABASE_DB_POOLER_MAX_CLIENT_CONN"] = "200";
      expect(envOverrideMaxClientConn(100, undefined)).toBe(200);
    });
  });

  describe("resolveAuthCaptcha", () => {
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"];
      delete process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"];
      delete process.env["SUPABASE_AUTH_CAPTCHA_SECRET"];
    });

    it("returns undefined when captcha is not configured", () => {
      expect(resolveAuthCaptcha(undefined, undefined, undefined)).toBeUndefined();
    });

    it("overrides enabled/provider when the section is present in the document", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = "true";
      process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"] = "turnstile";
      const authDocument = { captcha: { enabled: false, provider: "hcaptcha" } };
      const resolved = resolveAuthCaptcha(
        authDocument,
        { enabled: false, provider: "hcaptcha", secret: "shh" },
        undefined,
      );
      expect(resolved?.enabled).toBe(true);
      expect(resolved?.provider).toBe("turnstile");
    });

    it("does not apply an env override when [auth.captcha] is absent from the document", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = "true";
      const resolved = resolveAuthCaptcha(
        {},
        { enabled: false, provider: "hcaptcha", secret: "shh" },
        undefined,
      );
      expect(resolved?.enabled).toBe(false);
    });

    it("decrypts an encrypted: captcha secret", () => {
      process.env["DOTENV_PRIVATE_KEY"] =
        "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
      const authDocument = { captcha: { enabled: true } };
      const resolved = resolveAuthCaptcha(
        authDocument,
        {
          enabled: true,
          provider: "hcaptcha",
          secret:
            "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/",
        },
        undefined,
      );
      expect(resolved?.secret).toBe("value");
      delete process.env["DOTENV_PRIVATE_KEY"];
    });

    it("suppresses a malformed SUPABASE_AUTH_CAPTCHA_ENABLED when a remote block already set auth.captcha.enabled", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = "not-a-bool";
      const authDocument = { captcha: { enabled: false } };
      expect(() =>
        resolveAuthCaptcha(
          authDocument,
          { enabled: false, provider: "hcaptcha", secret: "shh" },
          undefined,
          new Set(["auth.captcha.enabled"]),
        ),
      ).not.toThrow();
    });

    it("still rejects a malformed SUPABASE_AUTH_CAPTCHA_ENABLED when no remote block matched", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = "not-a-bool";
      const authDocument = { captcha: { enabled: false } };
      expect(() =>
        resolveAuthCaptcha(
          authDocument,
          { enabled: false, provider: "hcaptcha", secret: "shh" },
          undefined,
        ),
      ).toThrow('cannot parse "not-a-bool" as a bool');
    });

    it("suppresses a malformed SUPABASE_AUTH_CAPTCHA_SECRET when a remote block already set auth.captcha.secret", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_SECRET"] = "encrypted:not-a-real-ciphertext";
      const authDocument = { captcha: { enabled: true } };
      const resolved = resolveAuthCaptcha(
        authDocument,
        { enabled: true, provider: "hcaptcha", secret: "remote-secret" },
        undefined,
        new Set(["auth.captcha.secret"]),
      );
      expect(resolved?.secret).toBe("remote-secret");
    });

    it("still rejects a malformed SUPABASE_AUTH_CAPTCHA_SECRET when no remote block matched", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_SECRET"] = "encrypted:not-a-real-ciphertext";
      const authDocument = { captcha: { enabled: true } };
      expect(() =>
        resolveAuthCaptcha(
          authDocument,
          { enabled: true, provider: "hcaptcha", secret: "remote-secret" },
          undefined,
        ),
      ).toThrow("failed to parse config: missing private key");
    });

    it("preserves a remote block's valid auth.captcha.provider over an unsupported ambient override", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"] = "recaptcha";
      const authDocument = { captcha: { enabled: true, provider: "hcaptcha" } };
      const resolved = resolveAuthCaptcha(
        authDocument,
        { enabled: true, provider: "hcaptcha", secret: "shh" },
        undefined,
        new Set(["auth.captcha.provider"]),
      );
      expect(resolved?.provider).toBe("hcaptcha");
    });

    it("still applies SUPABASE_AUTH_CAPTCHA_PROVIDER when no remote block matched", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"] = "turnstile";
      const authDocument = { captcha: { enabled: true, provider: "hcaptcha" } };
      const resolved = resolveAuthCaptcha(
        authDocument,
        { enabled: true, provider: "hcaptcha", secret: "shh" },
        undefined,
      );
      expect(resolved?.provider).toBe("turnstile");
    });
  });

  describe("resolveAuthEmail", () => {
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_SUBJECT"];
    });

    it("keeps an explicit empty subject present in the raw document, not omitted", () => {
      const config = baseConfig({
        auth: { email: { template: { confirmation: { subject: "", content_path: "x" } } } },
      });
      const authDocument = { email: { template: { confirmation: { subject: "" } } } };
      const resolved = resolveAuthEmail(config.auth.email, authDocument, undefined);
      expect(resolved.template["confirmation"]?.subject).toBe("");
    });

    it("omits the subject when the key is absent from the raw document", () => {
      const config = baseConfig({
        auth: { email: { template: { confirmation: { content_path: "x" } } } },
      });
      const authDocument = { email: { template: { confirmation: { content_path: "x" } } } };
      const resolved = resolveAuthEmail(config.auth.email, authDocument, undefined);
      expect(resolved.template["confirmation"]?.subject).toBeUndefined();
    });

    it("prefers an env-overridden subject over the raw document's presence, even when absent", () => {
      process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_SUBJECT"] = "Overridden subject";
      const config = baseConfig({
        auth: { email: { template: { confirmation: { content_path: "x" } } } },
      });
      const authDocument = { email: { template: { confirmation: { content_path: "x" } } } };
      const resolved = resolveAuthEmail(config.auth.email, authDocument, undefined);
      expect(resolved.template["confirmation"]?.subject).toBe("Overridden subject");
    });

    describe("max_frequency — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
      afterEach(() => {
        delete process.env["SUPABASE_AUTH_EMAIL_MAX_FREQUENCY"];
      });

      it("prefers a remote-set auth.email.max_frequency over a conflicting SUPABASE_AUTH_EMAIL_MAX_FREQUENCY", () => {
        process.env["SUPABASE_AUTH_EMAIL_MAX_FREQUENCY"] = "5s";
        const config = baseConfig({ auth: { email: { max_frequency: "1m" } } });
        const resolved = resolveAuthEmail(
          config.auth.email,
          undefined,
          undefined,
          new Set(["auth.email.max_frequency"]),
        );
        expect(resolved.max_frequency).toBe("1m");
      });

      it("still applies SUPABASE_AUTH_EMAIL_MAX_FREQUENCY when no remote block matched", () => {
        process.env["SUPABASE_AUTH_EMAIL_MAX_FREQUENCY"] = "5s";
        const config = baseConfig({ auth: { email: { max_frequency: "1m" } } });
        const resolved = resolveAuthEmail(config.auth.email, undefined, undefined);
        expect(resolved.max_frequency).toBe("5s");
      });
    });
  });

  describe("resolveAuthHooks", () => {
    const baseHook = { enabled: false, uri: "", secrets: "" };
    const allHooks = {
      mfa_verification_attempt: baseHook,
      password_verification_attempt: baseHook,
      custom_access_token: baseHook,
      send_sms: baseHook,
      send_email: baseHook,
      before_user_created: baseHook,
    };

    afterEach(() => {
      delete process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"];
      delete process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI"];
      delete process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS"];
    });

    it("leaves every hook disabled when nothing is configured or overridden", () => {
      const resolved = resolveAuthHooks(undefined, allHooks, undefined);
      expect(resolved.customAccessToken.enabled).toBe(false);
      expect(resolved.mfaVerificationAttempt.enabled).toBe(false);
    });

    it("overrides enabled/uri when the hook's section is present in the document", () => {
      process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"] = "true";
      process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI"] = "https://example.com/hook";
      const authDocument = { hook: { custom_access_token: { enabled: false } } };
      const resolved = resolveAuthHooks(authDocument, allHooks, undefined);
      expect(resolved.customAccessToken.enabled).toBe(true);
      expect(resolved.customAccessToken.uri).toBe("https://example.com/hook");
      expect(resolved.mfaVerificationAttempt.enabled).toBe(false);
    });

    it("does not apply an env override when the hook's section is absent from the document", () => {
      process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"] = "true";
      const resolved = resolveAuthHooks({}, allHooks, undefined);
      expect(resolved.customAccessToken.enabled).toBe(false);
    });

    it("suppresses a malformed SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED when a remote block already set that hook's enabled", () => {
      process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"] = "not-a-bool";
      const authDocument = { hook: { custom_access_token: { enabled: false } } };
      expect(() =>
        resolveAuthHooks(
          authDocument,
          allHooks,
          undefined,
          new Set(["auth.hook.custom_access_token.enabled"]),
        ),
      ).not.toThrow();
    });

    it("still rejects a malformed SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED when no remote block matched", () => {
      process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"] = "not-a-bool";
      const authDocument = { hook: { custom_access_token: { enabled: false } } };
      expect(() => resolveAuthHooks(authDocument, allHooks, undefined)).toThrow(
        'cannot parse "not-a-bool" as a bool',
      );
    });

    it("prefers a remote-set auth.hook.custom_access_token.uri over a conflicting SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI", () => {
      process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI"] = "ftp://example.com";
      const hooksWithRemoteUri = {
        ...allHooks,
        custom_access_token: { enabled: true, uri: "https://example.com/hook", secrets: "" },
      };
      const authDocument = { hook: { custom_access_token: { enabled: true } } };
      const resolved = resolveAuthHooks(
        authDocument,
        hooksWithRemoteUri,
        undefined,
        new Set(["auth.hook.custom_access_token.uri"]),
      );
      expect(resolved.customAccessToken.uri).toBe("https://example.com/hook");
    });

    it("prefers a remote-set auth.hook.custom_access_token.secrets over a conflicting SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS", () => {
      process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS"] = "env-secret";
      const hooksWithRemoteSecrets = {
        ...allHooks,
        custom_access_token: { enabled: true, uri: "", secrets: "remote-secret" },
      };
      const authDocument = { hook: { custom_access_token: { enabled: true } } };
      const resolved = resolveAuthHooks(
        authDocument,
        hooksWithRemoteSecrets,
        undefined,
        new Set(["auth.hook.custom_access_token.secrets"]),
      );
      expect(resolved.customAccessToken.secrets).toBe("remote-secret");
    });

    it("still applies the env override for uri when no remote block matched that leaf", () => {
      process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI"] = "https://env.example.com/hook";
      const hooksWithLocalUri = {
        ...allHooks,
        custom_access_token: { enabled: true, uri: "https://local.example.com/hook", secrets: "" },
      };
      const authDocument = { hook: { custom_access_token: { enabled: true } } };
      const resolved = resolveAuthHooks(authDocument, hooksWithLocalUri, undefined);
      expect(resolved.customAccessToken.uri).toBe("https://env.example.com/hook");
    });
  });

  describe("resolveAuthMfa — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"];
    });

    it("suppresses a malformed SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED when a remote block already set auth.mfa.totp.enroll_enabled", () => {
      process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"] = "not-a-bool";
      const mfa = baseConfig().auth.mfa;
      expect(() =>
        resolveAuthMfa(mfa, undefined, new Set(["auth.mfa.totp.enroll_enabled"])),
      ).not.toThrow();
    });

    it("still rejects a malformed SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED when no remote block matched", () => {
      process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"] = "not-a-bool";
      const mfa = baseConfig().auth.mfa;
      expect(() => resolveAuthMfa(mfa, undefined)).toThrow('cannot parse "not-a-bool" as a bool');
    });

    it("prefers a remote-set auth.mfa.phone.template over a conflicting SUPABASE_AUTH_MFA_PHONE_TEMPLATE", () => {
      process.env["SUPABASE_AUTH_MFA_PHONE_TEMPLATE"] = "env template";
      const mfa = {
        ...baseConfig().auth.mfa,
        phone: { ...baseConfig().auth.mfa.phone, template: "remote template" },
      };
      const resolved = resolveAuthMfa(mfa, undefined, new Set(["auth.mfa.phone.template"]));
      expect(resolved.phone.template).toBe("remote template");
      delete process.env["SUPABASE_AUTH_MFA_PHONE_TEMPLATE"];
    });

    it("still applies SUPABASE_AUTH_MFA_PHONE_TEMPLATE when no remote block matched", () => {
      process.env["SUPABASE_AUTH_MFA_PHONE_TEMPLATE"] = "env template";
      const mfa = {
        ...baseConfig().auth.mfa,
        phone: { ...baseConfig().auth.mfa.phone, template: "remote template" },
      };
      const resolved = resolveAuthMfa(mfa, undefined);
      expect(resolved.phone.template).toBe("env template");
      delete process.env["SUPABASE_AUTH_MFA_PHONE_TEMPLATE"];
    });

    it("prefers a remote-set auth.mfa.phone.max_frequency over a conflicting SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY", () => {
      process.env["SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY"] = "5s";
      const mfa = {
        ...baseConfig().auth.mfa,
        phone: { ...baseConfig().auth.mfa.phone, max_frequency: "1m" },
      };
      const resolved = resolveAuthMfa(mfa, undefined, new Set(["auth.mfa.phone.max_frequency"]));
      expect(resolved.phone.max_frequency).toBe("1m");
      delete process.env["SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY"];
    });

    it("still applies SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY when no remote block matched", () => {
      process.env["SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY"] = "5s";
      const mfa = {
        ...baseConfig().auth.mfa,
        phone: { ...baseConfig().auth.mfa.phone, max_frequency: "1m" },
      };
      const resolved = resolveAuthMfa(mfa, undefined);
      expect(resolved.phone.max_frequency).toBe("5s");
      delete process.env["SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY"];
    });
  });

  describe("resolveAuthEmailSmtp — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_ENABLED"];
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_PASS"];
    });

    it("suppresses a malformed SUPABASE_AUTH_EMAIL_SMTP_ENABLED when a remote block already set auth.email.smtp.enabled", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_ENABLED"] = "not-a-bool";
      const authDocument = { email: { smtp: { enabled: true } } };
      expect(() =>
        resolveAuthEmailSmtp(authDocument, undefined, new Set(["auth.email.smtp.enabled"])),
      ).not.toThrow();
    });

    it("still rejects a malformed SUPABASE_AUTH_EMAIL_SMTP_ENABLED when no remote block matched", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_ENABLED"] = "not-a-bool";
      const authDocument = { email: { smtp: { enabled: true } } };
      expect(() => resolveAuthEmailSmtp(authDocument, undefined)).toThrow(
        'cannot parse "not-a-bool" as a bool',
      );
    });

    it("suppresses a malformed SUPABASE_AUTH_EMAIL_SMTP_PASS when a remote block already set auth.email.smtp.pass", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_PASS"] = "encrypted:not-a-real-ciphertext";
      const authDocument = { email: { smtp: { enabled: true, pass: "remote-pass" } } };
      const resolved = resolveAuthEmailSmtp(
        authDocument,
        undefined,
        new Set(["auth.email.smtp.pass"]),
      );
      expect(resolved?.pass).toBe("remote-pass");
    });

    it("still rejects a malformed SUPABASE_AUTH_EMAIL_SMTP_PASS when no remote block matched", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_PASS"] = "encrypted:not-a-real-ciphertext";
      const authDocument = { email: { smtp: { enabled: true, pass: "remote-pass" } } };
      expect(() => resolveAuthEmailSmtp(authDocument, undefined)).toThrow(
        "failed to parse config: missing private key",
      );
    });

    it("prefers a remote-set auth.email.smtp.host over a conflicting SUPABASE_AUTH_EMAIL_SMTP_HOST", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_HOST"] = "smtp.env.example.com";
      const authDocument = { email: { smtp: { enabled: true, host: "smtp.remote.example.com" } } };
      const resolved = resolveAuthEmailSmtp(
        authDocument,
        undefined,
        new Set(["auth.email.smtp.host"]),
      );
      expect(resolved?.host).toBe("smtp.remote.example.com");
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_HOST"];
    });

    it("still applies SUPABASE_AUTH_EMAIL_SMTP_HOST when no remote block matched", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_HOST"] = "smtp.env.example.com";
      const authDocument = { email: { smtp: { enabled: true, host: "smtp.remote.example.com" } } };
      const resolved = resolveAuthEmailSmtp(authDocument, undefined);
      expect(resolved?.host).toBe("smtp.env.example.com");
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_HOST"];
    });

    it("prefers a remote-set auth.email.smtp.user over a conflicting SUPABASE_AUTH_EMAIL_SMTP_USER", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_USER"] = "env-user";
      const authDocument = { email: { smtp: { enabled: true, user: "remote-user" } } };
      const resolved = resolveAuthEmailSmtp(
        authDocument,
        undefined,
        new Set(["auth.email.smtp.user"]),
      );
      expect(resolved?.user).toBe("remote-user");
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_USER"];
    });

    it("still applies SUPABASE_AUTH_EMAIL_SMTP_USER when no remote block matched", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_USER"] = "env-user";
      const authDocument = { email: { smtp: { enabled: true, user: "remote-user" } } };
      const resolved = resolveAuthEmailSmtp(authDocument, undefined);
      expect(resolved?.user).toBe("env-user");
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_USER"];
    });

    it("prefers a remote-set auth.email.smtp.admin_email over a conflicting SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL"] = "env@example.com";
      const authDocument = {
        email: { smtp: { enabled: true, admin_email: "remote@example.com" } },
      };
      const resolved = resolveAuthEmailSmtp(
        authDocument,
        undefined,
        new Set(["auth.email.smtp.admin_email"]),
      );
      expect(resolved?.adminEmail).toBe("remote@example.com");
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL"];
    });

    it("still applies SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL when no remote block matched", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL"] = "env@example.com";
      const authDocument = {
        email: { smtp: { enabled: true, admin_email: "remote@example.com" } },
      };
      const resolved = resolveAuthEmailSmtp(authDocument, undefined);
      expect(resolved?.adminEmail).toBe("env@example.com");
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL"];
    });

    it("prefers a remote-set auth.email.smtp.sender_name over a conflicting SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME"] = "Env Sender";
      const authDocument = { email: { smtp: { enabled: true, sender_name: "Remote Sender" } } };
      const resolved = resolveAuthEmailSmtp(
        authDocument,
        undefined,
        new Set(["auth.email.smtp.sender_name"]),
      );
      expect(resolved?.senderName).toBe("Remote Sender");
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME"];
    });

    it("still applies SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME when no remote block matched", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME"] = "Env Sender";
      const authDocument = { email: { smtp: { enabled: true, sender_name: "Remote Sender" } } };
      const resolved = resolveAuthEmailSmtp(authDocument, undefined);
      expect(resolved?.senderName).toBe("Env Sender");
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME"];
    });
  });

  describe("resolveAuthExternalProviders", () => {
    it("coerces an env(...)-resolved boolean string for an unmodeled/custom provider", () => {
      const authDocument = {
        external: {
          my_custom: {
            enabled: "true",
            client_id: "custom-client-id",
            skip_nonce_check: "false",
            email_optional: "TRUE",
          },
        },
      };
      const resolved = resolveAuthExternalProviders(
        authDocument,
        baseConfig().auth.external,
        undefined,
      );
      expect(resolved["my_custom"]?.enabled).toBe(true);
      expect(resolved["my_custom"]?.skipNonceCheck).toBe(false);
      expect(resolved["my_custom"]?.emailOptional).toBe(true);
    });

    it("throws on an unparsable custom-provider boolean string instead of silently disabling it", () => {
      const authDocument = {
        external: { my_custom: { enabled: "not-a-bool", client_id: "custom-client-id" } },
      };
      expect(() =>
        resolveAuthExternalProviders(authDocument, baseConfig().auth.external, undefined),
      ).toThrow('cannot parse "not-a-bool" as a bool');
    });

    it("leaves an absent custom-provider boolean field at its schema default without throwing", () => {
      const authDocument = {
        external: { my_custom: { client_id: "custom-client-id" } },
      };
      const resolved = resolveAuthExternalProviders(
        authDocument,
        baseConfig().auth.external,
        undefined,
      );
      expect(resolved["my_custom"]?.enabled).toBe(false);
    });

    it("weakly coerces a raw numeric custom-provider boolean by truthiness, matching Go's WeaklyTypedInput decode", () => {
      const authDocument = {
        external: { my_custom: { enabled: 1, client_id: "custom-client-id" } },
      };
      const resolved = resolveAuthExternalProviders(
        authDocument,
        baseConfig().auth.external,
        undefined,
      );
      expect(resolved["my_custom"]?.enabled).toBe(true);
    });

    it("throws on a raw array/table custom-provider boolean instead of silently disabling it", () => {
      const authDocument = {
        external: { my_custom: { enabled: [1, 2], client_id: "custom-client-id" } },
      };
      expect(() =>
        resolveAuthExternalProviders(authDocument, baseConfig().auth.external, undefined),
      ).toThrow('cannot parse "1,2" as a bool');
    });

    it("resolves apple purely from env overrides even with no config.toml [auth.external] section at all, matching Go's ejected default template", () => {
      const projectEnvValues = {
        SUPABASE_AUTH_EXTERNAL_APPLE_ENABLED: "true",
        SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID: "apple-client-id",
        SUPABASE_AUTH_EXTERNAL_APPLE_SECRET: "apple-secret",
        SUPABASE_AUTH_EXTERNAL_APPLE_URL: "https://appleid.apple.com",
      };
      const resolved = resolveAuthExternalProviders(
        undefined,
        baseConfig().auth.external,
        projectEnvValues,
      );
      expect(resolved["apple"]).toEqual({
        enabled: true,
        clientId: "apple-client-id",
        secret: "apple-secret",
        url: "https://appleid.apple.com",
        redirectUri: "",
        skipNonceCheck: false,
        emailOptional: false,
      });
    });

    it("does not synthesize any other provider purely from an env override with no TOML table, only apple gets Go's default-template exception", () => {
      const projectEnvValues = {
        SUPABASE_AUTH_EXTERNAL_GOOGLE_ENABLED: "true",
        SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID: "google-client-id",
      };
      const resolved = resolveAuthExternalProviders(
        undefined,
        baseConfig().auth.external,
        projectEnvValues,
      );
      expect(resolved["google"]).toBeUndefined();
      expect(resolved["apple"]?.enabled).toBe(false);
    });
  });

  describe("resolveAuthExternalProviders — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
    it("prefers a remote-set auth.external.<name>.secret over a malformed SUPABASE_AUTH_EXTERNAL_<NAME>_SECRET", () => {
      const authDocument = {
        external: { my_custom: { enabled: true, secret: "remote-secret" } },
      };
      const projectEnvValues = { SUPABASE_AUTH_EXTERNAL_MY_CUSTOM_SECRET: "encrypted:garbage" };
      const resolved = resolveAuthExternalProviders(
        authDocument,
        baseConfig().auth.external,
        projectEnvValues,
        new Set(["auth.external.my_custom.secret"]),
      );
      expect(resolved["my_custom"]?.secret).toBe("remote-secret");
    });

    it("still rejects a malformed SUPABASE_AUTH_EXTERNAL_<NAME>_SECRET when no remote block matched", () => {
      const authDocument = {
        external: { my_custom: { enabled: true, secret: "remote-secret" } },
      };
      const projectEnvValues = { SUPABASE_AUTH_EXTERNAL_MY_CUSTOM_SECRET: "encrypted:garbage" };
      expect(() =>
        resolveAuthExternalProviders(authDocument, baseConfig().auth.external, projectEnvValues),
      ).toThrow("failed to parse config: missing private key");
    });

    it("prefers a remote-set auth.external.<name>.enabled over a malformed SUPABASE_AUTH_EXTERNAL_<NAME>_ENABLED", () => {
      const authDocument = { external: { my_custom: { enabled: true } } };
      const projectEnvValues = { SUPABASE_AUTH_EXTERNAL_MY_CUSTOM_ENABLED: "not-a-bool" };
      expect(() =>
        resolveAuthExternalProviders(
          authDocument,
          baseConfig().auth.external,
          projectEnvValues,
          new Set(["auth.external.my_custom.enabled"]),
        ),
      ).not.toThrow();
    });

    it("still rejects a malformed SUPABASE_AUTH_EXTERNAL_<NAME>_ENABLED when no remote block matched", () => {
      const authDocument = { external: { my_custom: { enabled: true } } };
      const projectEnvValues = { SUPABASE_AUTH_EXTERNAL_MY_CUSTOM_ENABLED: "not-a-bool" };
      expect(() =>
        resolveAuthExternalProviders(authDocument, baseConfig().auth.external, projectEnvValues),
      ).toThrow('cannot parse "not-a-bool" as a bool');
    });

    it("prefers a remote-set auth.external.<name>.client_id over a conflicting SUPABASE_AUTH_EXTERNAL_<NAME>_CLIENT_ID", () => {
      const authDocument = {
        external: { my_custom: { enabled: true, client_id: "remote-client-id" } },
      };
      const projectEnvValues = {
        SUPABASE_AUTH_EXTERNAL_MY_CUSTOM_CLIENT_ID: "env-should-not-win",
      };
      const resolved = resolveAuthExternalProviders(
        authDocument,
        baseConfig().auth.external,
        projectEnvValues,
        new Set(["auth.external.my_custom.client_id"]),
      );
      expect(resolved["my_custom"]?.clientId).toBe("remote-client-id");
    });
  });

  describe("rawUnmodeledBool", () => {
    it("returns false for an absent value, matching Go's zero-value bool default", () => {
      expect(rawUnmodeledBool(undefined, "auth.passkey.enabled")).toBe(false);
    });

    it("passes a real boolean through unchanged", () => {
      expect(rawUnmodeledBool(true, "auth.passkey.enabled")).toBe(true);
      expect(rawUnmodeledBool(false, "auth.passkey.enabled")).toBe(false);
    });

    it("weakly coerces a raw number by truthiness, matching mapstructure's WeaklyTypedInput decodeBool", () => {
      expect(rawUnmodeledBool(123, "auth.passkey.enabled")).toBe(true);
      expect(rawUnmodeledBool(0, "auth.passkey.enabled")).toBe(false);
      expect(rawUnmodeledBool(1.5, "auth.passkey.enabled")).toBe(true);
    });

    it("parses a valid boolean-ish string the way Go's strconv.ParseBool does", () => {
      expect(rawUnmodeledBool("true", "auth.passkey.enabled")).toBe(true);
      expect(rawUnmodeledBool("False", "auth.passkey.enabled")).toBe(false);
      expect(rawUnmodeledBool("", "auth.passkey.enabled")).toBe(false);
    });

    it("throws on an unparsable string instead of silently disabling it", () => {
      expect(() => rawUnmodeledBool("not-a-bool", "auth.passkey.enabled")).toThrow(
        'cannot parse "not-a-bool" as a bool',
      );
    });

    it("throws on an array or table value — mapstructure's decodeBool errors on these unconditionally, never weakly coerced", () => {
      expect(() => rawUnmodeledBool([1, 2], "auth.passkey.enabled")).toThrow(
        InvalidBoolEnvOverrideError,
      );
      expect(() => rawUnmodeledBool({ nested: true }, "auth.passkey.enabled")).toThrow(
        InvalidBoolEnvOverrideError,
      );
    });
  });

  describe("resolveDbSettingsEnvOverrides", () => {
    const ALL_OVERRIDE_NAMES = [
      "SUPABASE_DB_SETTINGS_EFFECTIVE_CACHE_SIZE",
      "SUPABASE_DB_SETTINGS_LOGICAL_DECODING_WORK_MEM",
      "SUPABASE_DB_SETTINGS_MAINTENANCE_WORK_MEM",
      "SUPABASE_DB_SETTINGS_MAX_CONNECTIONS",
      "SUPABASE_DB_SETTINGS_MAX_LOCKS_PER_TRANSACTION",
      "SUPABASE_DB_SETTINGS_MAX_PARALLEL_MAINTENANCE_WORKERS",
      "SUPABASE_DB_SETTINGS_MAX_PARALLEL_WORKERS",
      "SUPABASE_DB_SETTINGS_MAX_PARALLEL_WORKERS_PER_GATHER",
      "SUPABASE_DB_SETTINGS_MAX_REPLICATION_SLOTS",
      "SUPABASE_DB_SETTINGS_MAX_SLOT_WAL_KEEP_SIZE",
      "SUPABASE_DB_SETTINGS_MAX_STANDBY_ARCHIVE_DELAY",
      "SUPABASE_DB_SETTINGS_MAX_STANDBY_STREAMING_DELAY",
      "SUPABASE_DB_SETTINGS_MAX_WAL_SIZE",
      "SUPABASE_DB_SETTINGS_MAX_WAL_SENDERS",
      "SUPABASE_DB_SETTINGS_MAX_WORKER_PROCESSES",
      "SUPABASE_DB_SETTINGS_SESSION_REPLICATION_ROLE",
      "SUPABASE_DB_SETTINGS_SHARED_BUFFERS",
      "SUPABASE_DB_SETTINGS_STATEMENT_TIMEOUT",
      "SUPABASE_DB_SETTINGS_TRACK_ACTIVITY_QUERY_SIZE",
      "SUPABASE_DB_SETTINGS_TRACK_COMMIT_TIMESTAMP",
      "SUPABASE_DB_SETTINGS_WAL_KEEP_SIZE",
      "SUPABASE_DB_SETTINGS_WAL_SENDER_TIMEOUT",
      "SUPABASE_DB_SETTINGS_WORK_MEM",
    ];

    afterEach(() => {
      for (const name of ALL_OVERRIDE_NAMES) delete process.env[name];
    });

    it("returns the configured settings unchanged when nothing is overridden", () => {
      const settings = { shared_buffers: "128MB", max_connections: 100 };
      expect(resolveDbSettingsEnvOverrides(settings, undefined)).toEqual(settings);
    });

    it("leaves an unconfigured field undefined when nothing is overridden", () => {
      expect(resolveDbSettingsEnvOverrides({}, undefined).effective_cache_size).toBeUndefined();
    });

    it("overrides a string field via the env var", () => {
      process.env["SUPABASE_DB_SETTINGS_SHARED_BUFFERS"] = "256MB";
      expect(
        resolveDbSettingsEnvOverrides({ shared_buffers: "128MB" }, undefined).shared_buffers,
      ).toBe("256MB");
    });

    it("sets a string field via the env var even when not configured at all", () => {
      process.env["SUPABASE_DB_SETTINGS_WORK_MEM"] = "8MB";
      expect(resolveDbSettingsEnvOverrides({}, undefined).work_mem).toBe("8MB");
    });

    it("overrides a uint field via the env var", () => {
      process.env["SUPABASE_DB_SETTINGS_MAX_CONNECTIONS"] = "200";
      expect(
        resolveDbSettingsEnvOverrides({ max_connections: 100 }, undefined).max_connections,
      ).toBe(200);
    });

    it("rejects a non-numeric uint override", () => {
      process.env["SUPABASE_DB_SETTINGS_MAX_CONNECTIONS"] = "not-a-number";
      expect(() => resolveDbSettingsEnvOverrides({}, undefined)).toThrow(
        "Invalid db.settings.max_connections",
      );
    });

    it("resolves a 0x-prefixed uint override as hex", () => {
      process.env["SUPABASE_DB_SETTINGS_MAX_CONNECTIONS"] = "0x10";
      expect(
        resolveDbSettingsEnvOverrides({ max_connections: 100 }, undefined).max_connections,
      ).toBe(16);
    });

    it("rejects a uint override exceeding the uint64 max (2^64), matching Go's ParseUint failure", () => {
      process.env["SUPABASE_DB_SETTINGS_MAX_CONNECTIONS"] = "18446744073709551616";
      expect(() => resolveDbSettingsEnvOverrides({}, undefined)).toThrow(
        "Failed reading config: Invalid db.settings.max_connections: 18446744073709551616.",
      );
    });

    it("overrides the boolean field via the env var", () => {
      process.env["SUPABASE_DB_SETTINGS_TRACK_COMMIT_TIMESTAMP"] = "true";
      expect(
        resolveDbSettingsEnvOverrides({ track_commit_timestamp: false }, undefined)
          .track_commit_timestamp,
      ).toBe(true);
    });

    it("rejects a malformed boolean override", () => {
      process.env["SUPABASE_DB_SETTINGS_TRACK_COMMIT_TIMESTAMP"] = "not-a-bool";
      expect(() => resolveDbSettingsEnvOverrides({}, undefined)).toThrow(
        InvalidBoolEnvOverrideError,
      );
    });

    it("overrides the session_replication_role enum field via the env var", () => {
      process.env["SUPABASE_DB_SETTINGS_SESSION_REPLICATION_ROLE"] = "replica";
      expect(
        resolveDbSettingsEnvOverrides({ session_replication_role: "origin" }, undefined)
          .session_replication_role,
      ).toBe("replica");
    });

    it("leaves session_replication_role undefined when neither configured nor overridden", () => {
      expect(resolveDbSettingsEnvOverrides({}, undefined).session_replication_role).toBeUndefined();
    });

    it("rejects an invalid session_replication_role override", () => {
      process.env["SUPABASE_DB_SETTINGS_SESSION_REPLICATION_ROLE"] = "invalid";
      expect(() => resolveDbSettingsEnvOverrides({}, undefined)).toThrow(
        InvalidSessionReplicationRoleEnvOverrideError,
      );
      expect(() => resolveDbSettingsEnvOverrides({}, undefined)).toThrow(
        'Invalid config for db.settings.session_replication_role: cannot parse "invalid" as one of "origin", "replica", "local"',
      );
    });

    it("also honors a projectEnvValues (dotenv) value", () => {
      expect(
        resolveDbSettingsEnvOverrides({}, { SUPABASE_DB_SETTINGS_SHARED_BUFFERS: "512MB" })
          .shared_buffers,
      ).toBe("512MB");
    });
  });

  describe("auth.signing_keys_path (asymmetric JWT signing)", () => {
    const tempRoot = useTempWorkdir("supabase-signing-keys-test-");

    it("signs anon/service_role with the first RS256 key in the file", async () => {
      const jwk = generateRsaJwk();
      writeSigningKeys(tempRoot.current, [jwk]);
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);

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
      const values = resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
      expect(values.anonKey.split(".")).toHaveLength(3);
    });

    it("uses an absolute signing_keys_path as-is, without joining the workdir", async () => {
      const jwk = generateRsaJwk();
      writeSigningKeys(tempRoot.current, [jwk]);
      const absolutePath = join(tempRoot.current, "supabase", "signing_keys.json");
      const config = baseConfig({ auth: { signing_keys_path: absolutePath } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", "/some/unrelated/workdir");
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
      const values = resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
      expect(values.anonKey).toBe("configured-anon");
      expect(values.serviceRoleKey).toBe("configured-service-role");
    });

    it("falls back to HMAC signing when signing_keys_path resolves to an empty array", () => {
      writeSigningKeys(tempRoot.current, []);
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
      const [, payload] = values.anonKey.split(".");
      expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject({
        iss: "supabase-demo",
      });
    });

    it("throws a Go-worded error when the signing keys file does not exist", () => {
      const config = baseConfig({ auth: { signing_keys_path: "missing.json" } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to read signing keys: ",
      );
    });

    it("throws a Go-worded error when the signing keys file is malformed JSON", () => {
      const supabaseDir = join(tempRoot.current, "supabase");
      mkdirSync(supabaseDir, { recursive: true });
      writeFileSync(join(supabaseDir, "signing_keys.json"), "not valid json");
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to decode signing keys: ",
      );
    });

    it("throws when the first key uses an unsupported algorithm", () => {
      writeSigningKeys(tempRoot.current, [{ ...generateRsaJwk(), alg: "RS512" }]);
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "unsupported algorithm: RS512",
      );
    });

    it("skips reading a missing signing_keys_path when auth is disabled", () => {
      const config = baseConfig({
        auth: { enabled: false, signing_keys_path: "missing.json" },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("skips reading a malformed signing_keys_path when auth is disabled, but still signs asymmetrically with the default key", async () => {
      const supabaseDir = join(tempRoot.current, "supabase");
      mkdirSync(supabaseDir, { recursive: true });
      writeFileSync(join(supabaseDir, "signing_keys.json"), "not valid json");
      const config = baseConfig({
        auth: { enabled: false, signing_keys_path: "signing_keys.json" },
      });
      const values = resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
      // Disabled auth with a configured signing-keys path still signs with the default ES256 key,
      // not HMAC — signing depends on whether keys were loaded, not on auth being enabled.
      const publicKey = await importJWK(
        { ...DEFAULT_SIGNING_KEY, d: undefined, key_ops: undefined },
        "ES256",
      );
      const { payload, protectedHeader } = await jwtVerify(values.anonKey, publicKey);
      expect(payload).toMatchObject({ iss: "supabase-demo", role: "anon" });
      expect(protectedHeader).toMatchObject({ alg: "ES256", kid: DEFAULT_SIGNING_KEY.kid });
    });

    describe("SUPABASE_AUTH_ENABLED env override", () => {
      // Reads the post-override `auth.enabled` value, not raw TOML, so an env-only disable/enable
      // still gates whether `signing_keys_path` is read.
      afterEach(() => {
        delete process.env["SUPABASE_AUTH_ENABLED"];
      });

      it("skips reading a missing signing_keys_path when auth is disabled only via env", () => {
        process.env["SUPABASE_AUTH_ENABLED"] = "false";
        const config = baseConfig({
          auth: { enabled: true, signing_keys_path: "missing.json" },
        });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
      });

      it("reads signing_keys_path when auth is enabled only via env despite TOML saying disabled", async () => {
        process.env["SUPABASE_AUTH_ENABLED"] = "true";
        const jwk = generateRsaJwk();
        writeSigningKeys(tempRoot.current, [jwk]);
        const config = baseConfig({
          auth: { enabled: false, signing_keys_path: "signing_keys.json" },
        });
        const values = resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
        expect(values.anonKey.split(".")).toHaveLength(3);
      });

      it("rejects a malformed override instead of falling back to the configured value", () => {
        process.env["SUPABASE_AUTH_ENABLED"] = "not-a-bool";
        const config = baseConfig({
          auth: { enabled: false, signing_keys_path: "missing.json" },
        });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
          InvalidBoolEnvOverrideError,
        );
      });
    });
  });

  describe("auth.site_url (required field in config)", () => {
    // Required-field/range assertions live in config-validate.unit.test.ts; only env-override
    // mechanics are tested here.
    describe("SUPABASE_AUTH_ENABLED / SUPABASE_AUTH_SITE_URL env overrides", () => {
      afterEach(() => {
        delete process.env["SUPABASE_AUTH_ENABLED"];
        delete process.env["SUPABASE_AUTH_SITE_URL"];
      });

      it("rejects an empty site_url when auth is enabled only via env", () => {
        process.env["SUPABASE_AUTH_ENABLED"] = "true";
        const config = baseConfig({ auth: { enabled: false, site_url: "" } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: auth.site_url",
        );
      });

      it("does not throw when auth is disabled only via env, however empty site_url is", () => {
        process.env["SUPABASE_AUTH_ENABLED"] = "false";
        const config = baseConfig({ auth: { enabled: true, site_url: "" } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      it("accepts an env-provided site_url overriding an empty config.toml value", () => {
        process.env["SUPABASE_AUTH_SITE_URL"] = "http://localhost:4000";
        const config = baseConfig({ auth: { enabled: true, site_url: "" } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      it("exposes the overridden site_url on the returned values, not just for validation", () => {
        process.env["SUPABASE_AUTH_SITE_URL"] = "http://localhost:4000";
        const config = baseConfig({ auth: { enabled: true, site_url: "http://127.0.0.1:3000" } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.authSiteUrl).toBe("http://localhost:4000");
      });
    });
  });

  describe("auth.* flat scalar env overrides (GoTrue container env, not just validation)", () => {
    const AUTH_SCALAR_ENV_KEYS = [
      "SUPABASE_AUTH_JWT_ISSUER",
      "SUPABASE_AUTH_JWT_EXPIRY",
      "SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS",
      "SUPABASE_AUTH_ENABLE_SIGNUP",
      "SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS",
      "SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION",
      "SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL",
      "SUPABASE_AUTH_ENABLE_MANUAL_LINKING",
      "SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH",
      "SUPABASE_AUTH_PASSWORD_REQUIREMENTS",
    ];
    afterEach(() => {
      for (const key of AUTH_SCALAR_ENV_KEYS) delete process.env[key];
    });

    it("overrides every flat auth.* scalar GoTrue needs, not just the ones Validate checks", () => {
      process.env["SUPABASE_AUTH_JWT_ISSUER"] = "https://issuer.example.com";
      process.env["SUPABASE_AUTH_JWT_EXPIRY"] = "7200";
      process.env["SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS"] =
        "https://a.example.com,https://b.example.com";
      process.env["SUPABASE_AUTH_ENABLE_SIGNUP"] = "false";
      process.env["SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS"] = "true";
      process.env["SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION"] = "false";
      process.env["SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL"] = "20";
      process.env["SUPABASE_AUTH_ENABLE_MANUAL_LINKING"] = "true";
      process.env["SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH"] = "12";
      process.env["SUPABASE_AUTH_PASSWORD_REQUIREMENTS"] = "lower_upper_letters_digits";

      const config = baseConfig({
        auth: {
          jwt_expiry: 3600,
          additional_redirect_urls: [],
          enable_signup: true,
          enable_anonymous_sign_ins: false,
          enable_refresh_token_rotation: true,
          refresh_token_reuse_interval: 10,
          enable_manual_linking: false,
          minimum_password_length: 6,
          password_requirements: "",
        },
      });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);

      expect(values.authJwtIssuer).toBe("https://issuer.example.com");
      expect(values.authJwtExpiry).toBe(7200);
      expect(values.authAdditionalRedirectUrls).toEqual([
        "https://a.example.com",
        "https://b.example.com",
      ]);
      expect(values.authEnableSignup).toBe(false);
      expect(values.authEnableAnonymousSignIns).toBe(true);
      expect(values.authEnableRefreshTokenRotation).toBe(false);
      expect(values.authRefreshTokenReuseInterval).toBe(20);
      expect(values.authEnableManualLinking).toBe(true);
      expect(values.authMinimumPasswordLength).toBe(12);
      expect(values.authPasswordRequirements).toBe("lower_upper_letters_digits");
    });

    it("rejects an unrecognized SUPABASE_AUTH_PASSWORD_REQUIREMENTS override, matching Go's UnmarshalText", () => {
      process.env["SUPABASE_AUTH_PASSWORD_REQUIREMENTS"] = "bogus";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid auth.password_requirements: bogus",
      );
    });
  });

  // Required-field/range assertions live in config-validate.unit.test.ts; only env-override
  // mechanics are tested here.

  describe("auth.captcha env overrides", () => {
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"];
      delete process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"];
      delete process.env["SUPABASE_AUTH_CAPTCHA_SECRET"];
    });

    it("rejects a captcha section enabled only via env with no provider", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = "true";
      const config = baseConfig({ auth: { captcha: { enabled: false } } });
      const document = { auth: { captcha: { enabled: false } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.captcha.provider");
    });

    it("does not throw when an incomplete enabled captcha section is disabled only via env", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = "false";
      const config = baseConfig({ auth: { captcha: { enabled: true } } });
      const document = { auth: { captcha: { enabled: true } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("accepts env-provided provider/secret overriding an enabled captcha section", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"] = "hcaptcha";
      process.env["SUPABASE_AUTH_CAPTCHA_SECRET"] = "shh";
      const config = baseConfig({ auth: { captcha: { enabled: true } } });
      const document = { auth: { captcha: { enabled: true } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not synthesize a captcha section purely from an env override when [auth.captcha] is absent", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.passkey / auth.webauthn env overrides", () => {
    // `auth.passkey`/`auth.webauthn` have no decoded-schema presence signal, so these tests thread
    // a raw `document` object through explicitly instead of relying on `baseConfig`.
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_PASSKEY_ENABLED"];
      delete process.env["SUPABASE_AUTH_WEBAUTHN_RP_ID"];
      delete process.env["SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS"];
    });

    it("rejects a passkey section enabled only via env with no [auth.webauthn] section", () => {
      process.env["SUPABASE_AUTH_PASSKEY_ENABLED"] = "true";
      const config = baseConfig();
      const document = { auth: { passkey: { enabled: false } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow(
        "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
      );
    });

    it("accepts env-provided rp_id/rp_origins overriding an incomplete [auth.webauthn] section", () => {
      process.env["SUPABASE_AUTH_PASSKEY_ENABLED"] = "true";
      process.env["SUPABASE_AUTH_WEBAUTHN_RP_ID"] = "localhost";
      process.env["SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS"] =
        "http://localhost:3000,http://localhost:3001";
      const config = baseConfig();
      const document = { auth: { passkey: { enabled: false }, webauthn: {} } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not synthesize a passkey section purely from an env override when [auth.passkey] is absent from the document", () => {
      process.env["SUPABASE_AUTH_PASSKEY_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("throws on an unparsable raw auth.passkey.enabled string instead of silently disabling it", () => {
      const config = baseConfig();
      const document = { auth: { passkey: { enabled: "not-a-bool" } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow('cannot parse "not-a-bool" as a bool');
    });
  });

  describe("auth.hook.* env overrides", () => {
    // The hook schema always decodes a default `{ enabled: false }` regardless of file presence,
    // so presence here is read from the raw `document`, not the decoded `config`.
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED"];
      delete process.env["SUPABASE_AUTH_HOOK_SEND_EMAIL_URI"];
      delete process.env["SUPABASE_AUTH_HOOK_SEND_EMAIL_SECRETS"];
    });

    it("rejects a hook section enabled only via env with no uri", () => {
      process.env["SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED"] = "true";
      const config = baseConfig();
      const document = { auth: { hook: { send_email: { enabled: false } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.hook.send_email.uri");
    });

    it("accepts an env-provided uri overriding a TOML-enabled hook missing its uri", () => {
      process.env["SUPABASE_AUTH_HOOK_SEND_EMAIL_URI"] = "pg-functions://postgres/auth/hook";
      const config = baseConfig({ auth: { hook: { send_email: { enabled: true } } } });
      const document = { auth: { hook: { send_email: { enabled: true } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not synthesize a hook enablement purely from an env override when the section is absent from the document", () => {
      process.env["SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.email.smtp env overrides", () => {
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_ENABLED"];
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_HOST"];
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_PORT"];
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_USER"];
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_PASS"];
      delete process.env["SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL"];
    });

    it("rejects an smtp section enabled only via env with no host", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_ENABLED"] = "true";
      const config = baseConfig();
      const document = { auth: { email: { smtp: { enabled: false } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.email.smtp.host");
    });

    it("accepts env-provided host/port/user/pass/admin_email overriding an enabled-but-incomplete smtp section", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_HOST"] = "smtp.example.com";
      process.env["SUPABASE_AUTH_EMAIL_SMTP_PORT"] = "587";
      process.env["SUPABASE_AUTH_EMAIL_SMTP_USER"] = "user";
      process.env["SUPABASE_AUTH_EMAIL_SMTP_PASS"] = "pass";
      process.env["SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL"] = "admin@example.com";
      const config = baseConfig();
      const document = { auth: { email: { smtp: { enabled: true } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("rejects an invalid SUPABASE_AUTH_EMAIL_SMTP_PORT override", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_HOST"] = "smtp.example.com";
      process.env["SUPABASE_AUTH_EMAIL_SMTP_PORT"] = "not-a-port";
      process.env["SUPABASE_AUTH_EMAIL_SMTP_USER"] = "user";
      process.env["SUPABASE_AUTH_EMAIL_SMTP_PASS"] = "pass";
      process.env["SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL"] = "admin@example.com";
      const config = baseConfig();
      const document = { auth: { email: { smtp: { enabled: true } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow(InvalidPortEnvOverrideError);
    });

    it("does not synthesize an smtp section purely from an env override when [auth.email.smtp] is absent from the document", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.mfa env overrides", () => {
    // These are plain value-typed fields with no presence gate, unlike hooks/smtp above — they're
    // overridable unconditionally.
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"];
      delete process.env["SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED"];
    });

    it("rejects an env-enabled enroll factor left at its TOML-decoded verify default", () => {
      process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid MFA config: auth.mfa.totp.enroll_enabled requires verify_enabled",
      );
    });

    it("accepts an env-enabled enroll factor when verify is also env-enabled", () => {
      process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"] = "true";
      process.env["SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects a malformed SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED override", () => {
      process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"] = "not-a-bool";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        InvalidBoolEnvOverrideError,
      );
    });
  });

  describe("auth.third_party env overrides", () => {
    // Same as auth.mfa above — including workos, whose default template omits the whole section
    // yet leaves it still unconditionally overridable.
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED"];
      delete process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID"];
    });

    it("rejects a third-party provider enabled only via env with no required field configured", () => {
      process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
      );
    });

    it("accepts an env-provided project_id overriding a TOML-enabled firebase provider", () => {
      process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID"] = "my-project";
      const config = baseConfig({ auth: { third_party: { firebase: { enabled: true } } } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not enable a third-party provider purely from a required-field env override", () => {
      process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID"] = "my-project";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.email.template/notification (content_path validation)", () => {
    const tempRoot = useTempWorkdir("supabase-email-templates-test-");

    it("rejects a template content_path pointing at a missing file", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: { content_path: "missing-invite.html" } } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "Invalid config for auth.email.template.invite.content_path: ",
      );
    });

    it("rejects an absolute template content_path outside the project root", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: { content_path: "/etc/hosts" } } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        'Invalid config for auth.email.template.invite.content_path: "/etc/hosts" resolves outside the project root',
      );
    });

    it("resolves a relative template content_path against the workdir itself, not <workdir>/supabase", () => {
      writeFileSync(join(tempRoot.current, "invite.html"), "<html></html>");
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: { content_path: "invite.html" } } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("does not throw a template with no content_path configured", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: {} } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("rejects an enabled notification content_path pointing at a missing file", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: {
            notification: { password_changed: { enabled: true, content_path: "missing.html" } },
          },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "Invalid config for auth.email.notification.password_changed.content_path: ",
      );
    });

    it("resolves a relative notification content_path against the workdir", () => {
      const templateDir = join(tempRoot.current, "supabase", "templates");
      mkdirSync(templateDir, { recursive: true });
      writeFileSync(join(templateDir, "pw-changed.html"), "<html></html>");
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: {
            notification: {
              password_changed: {
                enabled: true,
                content_path: "supabase/templates/pw-changed.html",
              },
            },
          },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("does not throw a disabled notification's missing content_path", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: {
            notification: {
              password_changed: { enabled: false, content_path: "missing.html" },
            },
          },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("does not throw a missing template content_path when auth is disabled", () => {
      const config = baseConfig({
        auth: { enabled: false, email: { template: { invite: { content_path: "missing.html" } } } },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("rejects a template content key present without content_path", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: {} } },
        },
      });
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current, undefined, {
          auth: { email: { template: { invite: { content: "<html>Hi</html>" } } } },
        }),
      ).toThrow(
        "Invalid config for auth.email.template.invite.content: please use content_path instead",
      );
    });
  });

  describe("auth.email.template/notification env overrides", () => {
    // No raw-document presence gate needed here: `email.template`/`email.notification` are
    // `Schema.Record`s, so the decoded config already reflects presence.
    const tempRoot = useTempWorkdir("supabase-email-template-env-test-");

    afterEach(() => {
      delete process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH"];
      delete process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT"];
      delete process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED"];
      delete process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT_PATH"];
      delete process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT"];
    });

    it("lets an env-provided template content_path override a missing TOML content_path", () => {
      writeFileSync(join(tempRoot.current, "invite.html"), "<html></html>");
      process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH"] = "invite.html";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: {} } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("rejects a notification enabled only via env with a missing content_path file", () => {
      process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED"] = "true";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: {
            notification: { password_changed: { enabled: false, content_path: "missing.html" } },
          },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "Invalid config for auth.email.notification.password_changed.content_path: ",
      );
    });

    it("does not validate a notification disabled only via env despite a TOML-enabled section", () => {
      process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED"] = "false";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: {
            notification: { password_changed: { enabled: true, content_path: "missing.html" } },
          },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("lets an env-provided notification content_path override a missing TOML content_path", () => {
      writeFileSync(join(tempRoot.current, "pw-changed.html"), "<html></html>");
      process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT_PATH"] =
        "pw-changed.html";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { notification: { password_changed: { enabled: true } } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("rejects a template _CONTENT env override with no content_path configured", () => {
      process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT"] = "<html>Hi</html>";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: {} } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "Invalid config for auth.email.template.invite.content: please use content_path instead",
      );
    });

    it("rejects an enabled notification's _CONTENT env override with no content_path configured", () => {
      process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT"] = "<html>Hi</html>";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { notification: { password_changed: { enabled: true } } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "Invalid config for auth.email.notification.password_changed.content: please use content_path instead",
      );
    });

    it("does not validate a disabled notification's _CONTENT env override", () => {
      process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT"] = "<html>Hi</html>";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { notification: { password_changed: { enabled: false } } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("lets a simultaneous template _CONTENT_PATH env override win over a _CONTENT env override", () => {
      writeFileSync(join(tempRoot.current, "invite.html"), "<html></html>");
      process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT"] = "<html>Hi</html>";
      process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH"] = "invite.html";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: {} } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("preserves a remote block's valid template content_path over a missing-file ambient override", () => {
      writeFileSync(join(tempRoot.current, "invite.html"), "<html></html>");
      process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH"] = "missing.html";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: { content_path: "invite.html" } } },
        },
      });
      expect(() =>
        resolveLocalConfigValues(
          config,
          "127.0.0.1",
          tempRoot.current,
          undefined,
          undefined,
          new Set(["auth.email.template.invite.content_path"]),
        ),
      ).not.toThrow();
    });

    it("still applies a template _CONTENT_PATH override to a missing file when no remote block matched", () => {
      process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH"] = "missing.html";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: { content_path: "invite.html" } } },
        },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "Invalid config for auth.email.template.invite.content_path: ",
      );
    });

    it("preserves a remote block's valid notification content_path over a missing-file ambient override", () => {
      writeFileSync(join(tempRoot.current, "pw-changed.html"), "<html></html>");
      process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT_PATH"] =
        "missing.html";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: {
            notification: {
              password_changed: { enabled: true, content_path: "pw-changed.html" },
            },
          },
        },
      });
      expect(() =>
        resolveLocalConfigValues(
          config,
          "127.0.0.1",
          tempRoot.current,
          undefined,
          undefined,
          new Set(["auth.email.notification.password_changed.content_path"]),
        ),
      ).not.toThrow();
    });

    it("suppresses a malformed ambient notification _ENABLED when a remote block already set enabled", () => {
      process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED"] = "not-a-bool";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { notification: { password_changed: { enabled: false } } },
        },
      });
      expect(() =>
        resolveLocalConfigValues(
          config,
          "127.0.0.1",
          tempRoot.current,
          undefined,
          undefined,
          new Set(["auth.email.notification.password_changed.enabled"]),
        ),
      ).not.toThrow();
    });
  });

  // Required-field/range assertions live in config-validate.unit.test.ts; only env-override
  // mechanics are tested here.

  describe("auth.external (external.validate(), D-only, ported to L)", () => {
    // Unmodeled external providers are silently dropped by the decoded config, so this reads the
    // raw `document` (5th param) instead.
    it("rejects an enabled unmodeled external provider missing client_id", () => {
      const config = baseConfig();
      const document = { auth: { external: { custom: { enabled: true } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.external.custom.client_id");
    });

    it("rejects an enabled unmodeled external provider missing secret", () => {
      const config = baseConfig();
      const document = {
        auth: { external: { custom: { enabled: true, client_id: "abc" } } },
      };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.external.custom.secret");
    });

    it("does not require a secret for apple/google providers", () => {
      const config = baseConfig();
      const document = {
        auth: { external: { apple: { enabled: true, client_id: "abc" } } },
      };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("skips deprecated linkedin/slack providers", () => {
      const config = baseConfig();
      const document = { auth: { external: { slack: { enabled: true } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not validate a disabled unmodeled external provider", () => {
      const config = baseConfig();
      const document = { auth: { external: { custom: { enabled: false } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("skips the check entirely when no document is threaded through", () => {
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.external env overrides", () => {
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_EXTERNAL_CUSTOM_ENABLED"];
      delete process.env["SUPABASE_AUTH_EXTERNAL_CUSTOM_CLIENT_ID"];
      delete process.env["SUPABASE_AUTH_EXTERNAL_CUSTOM_SECRET"];
    });

    it("rejects a provider enabled only via env with no client_id", () => {
      process.env["SUPABASE_AUTH_EXTERNAL_CUSTOM_ENABLED"] = "true";
      const config = baseConfig();
      const document = { auth: { external: { custom: { enabled: false } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.external.custom.client_id");
    });

    it("accepts env-provided client_id/secret overriding a TOML-enabled provider missing both", () => {
      process.env["SUPABASE_AUTH_EXTERNAL_CUSTOM_CLIENT_ID"] = "abc";
      process.env["SUPABASE_AUTH_EXTERNAL_CUSTOM_SECRET"] = "shh";
      const config = baseConfig();
      const document = { auth: { external: { custom: { enabled: true } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not synthesize a provider purely from an env override when the section is absent from the document", () => {
      process.env["SUPABASE_AUTH_EXTERNAL_CUSTOM_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.sms env overrides (provider switch)", () => {
    // Validates only the first enabled provider, in priority order (twilio, twilio_verify,
    // messagebird, textlocal, vonage), re-run here against the raw document with env overrides
    // applied.
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_SMS_TWILIO_ENABLED"];
      delete process.env["SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID"];
      delete process.env["SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID"];
      delete process.env["SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN"];
      delete process.env["SUPABASE_AUTH_SMS_MESSAGEBIRD_ENABLED"];
    });

    it("rejects a provider enabled only via env with missing required fields", () => {
      process.env["SUPABASE_AUTH_SMS_TWILIO_ENABLED"] = "true";
      const config = baseConfig();
      const document = { auth: { sms: { twilio: { enabled: false } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.sms.twilio.account_sid");
    });

    it("accepts env-provided credentials overriding a TOML-enabled provider missing them", () => {
      process.env["SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID"] = "AC123";
      process.env["SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID"] = "MG123";
      process.env["SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN"] = "tok";
      const config = baseConfig();
      const document = { auth: { sms: { twilio: { enabled: true } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("only validates the first enabled provider in Go's fixed priority order", () => {
      process.env["SUPABASE_AUTH_SMS_TWILIO_ENABLED"] = "false";
      process.env["SUPABASE_AUTH_SMS_MESSAGEBIRD_ENABLED"] = "true";
      const config = baseConfig();
      const document = {
        auth: { sms: { twilio: { enabled: true }, messagebird: { enabled: false } } },
      };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.sms.messagebird.originator");
    });

    it("throws for a provider enabled only via env with missing required fields even when the document has no auth.sms section at all", () => {
      // Unlike the other 4 providers, twilio's presence isn't gated on the document — the default
      // config always registers `auth.sms.twilio.*`, so enabling only via env still fails
      // validation instead of doing nothing.
      process.env["SUPABASE_AUTH_SMS_TWILIO_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: auth.sms.twilio.account_sid",
      );
    });

    it("resolves a fully env-only twilio configuration with no auth.sms.twilio document section", () => {
      process.env["SUPABASE_AUTH_SMS_TWILIO_ENABLED"] = "true";
      process.env["SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID"] = "AC123";
      process.env["SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID"] = "MG123";
      process.env["SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN"] = "tok";
      const resolved = resolveAuthSms(undefined, baseConfig().auth.sms, undefined);
      expect(resolved.twilio.enabled).toBe(true);
      expect(resolved.twilio.account_sid).toBe("AC123");
      expect(resolved.twilio.message_service_sid).toBe("MG123");
      expect(resolved.twilio.auth_token).toBe("tok");
    });

    it("still does not synthesize messagebird purely from an env override when the section is absent from the document", () => {
      // Unlike twilio, messagebird has no entry in the default config template, so an absent
      // section genuinely means it was never registered.
      process.env["SUPABASE_AUTH_SMS_MESSAGEBIRD_ENABLED"] = "true";
      const config = baseConfig();
      const resolved = resolveAuthSms(undefined, config.auth.sms, undefined);
      expect(resolved.messagebird.enabled).toBe(false);
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("resolveAuthSms (top-level scalars)", () => {
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"];
      delete process.env["SUPABASE_AUTH_SMS_ENABLE_CONFIRMATIONS"];
      delete process.env["SUPABASE_AUTH_SMS_MAX_FREQUENCY"];
      delete process.env["SUPABASE_AUTH_SMS_TEMPLATE"];
    });

    it("overrides enable_signup/enable_confirmations/max_frequency/template with no presence gate", () => {
      process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = "true";
      process.env["SUPABASE_AUTH_SMS_ENABLE_CONFIRMATIONS"] = "true";
      process.env["SUPABASE_AUTH_SMS_MAX_FREQUENCY"] = "10s";
      process.env["SUPABASE_AUTH_SMS_TEMPLATE"] = "Your OTP is {{ .Code }}";
      // A provider must be enabled, or `enable_signup` gets downgraded to false regardless of the
      // override.
      const configured = {
        ...baseConfig().auth.sms,
        twilio: { ...baseConfig().auth.sms.twilio, enabled: true },
      };
      const resolved = resolveAuthSms(undefined, configured, undefined);
      expect(resolved.enable_signup).toBe(true);
      expect(resolved.enable_confirmations).toBe(true);
      expect(resolved.max_frequency).toBe("10s");
      expect(resolved.template).toBe("Your OTP is {{ .Code }}");
    });

    it("leaves the scalars at their configured values when nothing is overridden", () => {
      const configured = {
        ...baseConfig().auth.sms,
        enable_signup: true,
        max_frequency: "5s",
        twilio: { ...baseConfig().auth.sms.twilio, enabled: true },
      };
      const resolved = resolveAuthSms(undefined, configured, undefined);
      expect(resolved.enable_signup).toBe(true);
      expect(resolved.max_frequency).toBe("5s");
    });
  });

  describe("resolveAuthSms (disables phone login with no provider enabled)", () => {
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"];
    });

    it("downgrades enable_signup to false when configured true with no provider enabled", () => {
      const configured = { ...baseConfig().auth.sms, enable_signup: true };
      const resolved = resolveAuthSms(undefined, configured, undefined);
      expect(resolved.enable_signup).toBe(false);
    });

    it("downgrades an env-overridden enable_signup to false with no provider enabled", () => {
      process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = "true";
      const resolved = resolveAuthSms(undefined, baseConfig().auth.sms, undefined);
      expect(resolved.enable_signup).toBe(false);
    });

    it("leaves enable_signup alone when a provider is enabled", () => {
      const configured = {
        ...baseConfig().auth.sms,
        enable_signup: true,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true },
      };
      const resolved = resolveAuthSms(undefined, configured, undefined);
      expect(resolved.enable_signup).toBe(true);
    });

    it("leaves enable_signup at false when already false with no provider enabled", () => {
      const resolved = resolveAuthSms(undefined, baseConfig().auth.sms, undefined);
      expect(resolved.enable_signup).toBe(false);
    });
  });

  describe("resolveAuthSms — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"];
      delete process.env["SUPABASE_AUTH_SMS_VONAGE_ENABLED"];
      delete process.env["SUPABASE_AUTH_SMS_VONAGE_API_SECRET"];
    });

    it("suppresses a malformed SUPABASE_AUTH_SMS_ENABLE_SIGNUP when a remote block already set auth.sms.enable_signup", () => {
      process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = "not-a-bool";
      const configured = {
        ...baseConfig().auth.sms,
        enable_signup: true,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true },
      };
      expect(() =>
        resolveAuthSms(undefined, configured, undefined, new Set(["auth.sms.enable_signup"])),
      ).not.toThrow();
    });

    it("still rejects a malformed SUPABASE_AUTH_SMS_ENABLE_SIGNUP when no remote block matched", () => {
      process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = "not-a-bool";
      const configured = {
        ...baseConfig().auth.sms,
        enable_signup: true,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true },
      };
      expect(() => resolveAuthSms(undefined, configured, undefined)).toThrow(
        'cannot parse "not-a-bool" as a bool',
      );
    });

    it("suppresses a malformed SUPABASE_AUTH_SMS_VONAGE_ENABLED when a remote block already set auth.sms.vonage.enabled", () => {
      process.env["SUPABASE_AUTH_SMS_VONAGE_ENABLED"] = "not-a-bool";
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true },
      };
      expect(() =>
        resolveAuthSms(undefined, configured, undefined, new Set(["auth.sms.vonage.enabled"])),
      ).not.toThrow();
    });

    it("prefers a remote-set auth.sms.vonage.api_secret over a malformed SUPABASE_AUTH_SMS_VONAGE_API_SECRET", () => {
      process.env["SUPABASE_AUTH_SMS_VONAGE_API_SECRET"] = "encrypted:garbage";
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true, api_secret: "remote-secret" },
      };
      const resolved = resolveAuthSms(
        undefined,
        configured,
        undefined,
        new Set(["auth.sms.vonage.enabled", "auth.sms.vonage.api_secret"]),
      );
      expect(resolved.vonage.api_secret).toBe("remote-secret");
    });

    it("still rejects a malformed SUPABASE_AUTH_SMS_VONAGE_API_SECRET when no remote block matched", () => {
      process.env["SUPABASE_AUTH_SMS_VONAGE_API_SECRET"] = "encrypted:garbage";
      const authDocument = { sms: { vonage: {} } };
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true, api_secret: "remote-secret" },
      };
      expect(() => resolveAuthSms(authDocument, configured, undefined)).toThrow(
        "failed to parse config: missing private key",
      );
    });

    it("prefers a remote-set auth.sms.twilio.account_sid over a conflicting SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID", () => {
      process.env["SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID"] = "env-sid";
      const configured = {
        ...baseConfig().auth.sms,
        twilio: { ...baseConfig().auth.sms.twilio, account_sid: "remote-sid" },
      };
      const resolved = resolveAuthSms(
        undefined,
        configured,
        undefined,
        new Set(["auth.sms.twilio.account_sid"]),
      );
      expect(resolved.twilio.account_sid).toBe("remote-sid");
      delete process.env["SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID"];
    });

    it("still applies SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID when no remote block matched", () => {
      process.env["SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID"] = "env-sid";
      const configured = {
        ...baseConfig().auth.sms,
        twilio: { ...baseConfig().auth.sms.twilio, account_sid: "remote-sid" },
      };
      const resolved = resolveAuthSms(undefined, configured, undefined);
      expect(resolved.twilio.account_sid).toBe("env-sid");
      delete process.env["SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID"];
    });

    it("prefers a remote-set auth.sms.vonage.from over a conflicting SUPABASE_AUTH_SMS_VONAGE_FROM", () => {
      process.env["SUPABASE_AUTH_SMS_VONAGE_FROM"] = "env-from";
      const authDocument = { sms: { vonage: { from: "remote-from" } } };
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, from: "remote-from" },
      };
      const resolved = resolveAuthSms(
        authDocument,
        configured,
        undefined,
        new Set(["auth.sms.vonage.from"]),
      );
      expect(resolved.vonage.from).toBe("remote-from");
      delete process.env["SUPABASE_AUTH_SMS_VONAGE_FROM"];
    });

    it("still applies SUPABASE_AUTH_SMS_VONAGE_FROM when no remote block matched", () => {
      process.env["SUPABASE_AUTH_SMS_VONAGE_FROM"] = "env-from";
      const authDocument = { sms: { vonage: { from: "remote-from" } } };
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, from: "remote-from" },
      };
      const resolved = resolveAuthSms(authDocument, configured, undefined);
      expect(resolved.vonage.from).toBe("env-from");
      delete process.env["SUPABASE_AUTH_SMS_VONAGE_FROM"];
    });

    it("prefers a remote-set auth.sms.vonage.api_key over a conflicting SUPABASE_AUTH_SMS_VONAGE_API_KEY", () => {
      process.env["SUPABASE_AUTH_SMS_VONAGE_API_KEY"] = "env-key";
      const authDocument = { sms: { vonage: { api_key: "remote-key" } } };
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, api_key: "remote-key" },
      };
      const resolved = resolveAuthSms(
        authDocument,
        configured,
        undefined,
        new Set(["auth.sms.vonage.api_key"]),
      );
      expect(resolved.vonage.api_key).toBe("remote-key");
      delete process.env["SUPABASE_AUTH_SMS_VONAGE_API_KEY"];
    });

    it("still applies SUPABASE_AUTH_SMS_VONAGE_API_KEY when no remote block matched", () => {
      process.env["SUPABASE_AUTH_SMS_VONAGE_API_KEY"] = "env-key";
      const authDocument = { sms: { vonage: { api_key: "remote-key" } } };
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, api_key: "remote-key" },
      };
      const resolved = resolveAuthSms(authDocument, configured, undefined);
      expect(resolved.vonage.api_key).toBe("env-key");
      delete process.env["SUPABASE_AUTH_SMS_VONAGE_API_KEY"];
    });

    it("prefers a remote-set auth.sms.template over a conflicting SUPABASE_AUTH_SMS_TEMPLATE", () => {
      process.env["SUPABASE_AUTH_SMS_TEMPLATE"] = "env template";
      const configured = { ...baseConfig().auth.sms, template: "remote template" };
      const resolved = resolveAuthSms(
        undefined,
        configured,
        undefined,
        new Set(["auth.sms.template"]),
      );
      expect(resolved.template).toBe("remote template");
      delete process.env["SUPABASE_AUTH_SMS_TEMPLATE"];
    });

    it("still applies SUPABASE_AUTH_SMS_TEMPLATE when no remote block matched", () => {
      process.env["SUPABASE_AUTH_SMS_TEMPLATE"] = "env template";
      const configured = { ...baseConfig().auth.sms, template: "remote template" };
      const resolved = resolveAuthSms(undefined, configured, undefined);
      expect(resolved.template).toBe("env template");
      delete process.env["SUPABASE_AUTH_SMS_TEMPLATE"];
    });

    it("prefers a remote-set auth.sms.max_frequency over a conflicting SUPABASE_AUTH_SMS_MAX_FREQUENCY", () => {
      process.env["SUPABASE_AUTH_SMS_MAX_FREQUENCY"] = "5s";
      const configured = { ...baseConfig().auth.sms, max_frequency: "1m" };
      const resolved = resolveAuthSms(
        undefined,
        configured,
        undefined,
        new Set(["auth.sms.max_frequency"]),
      );
      expect(resolved.max_frequency).toBe("1m");
      delete process.env["SUPABASE_AUTH_SMS_MAX_FREQUENCY"];
    });

    it("still applies SUPABASE_AUTH_SMS_MAX_FREQUENCY when no remote block matched", () => {
      process.env["SUPABASE_AUTH_SMS_MAX_FREQUENCY"] = "5s";
      const configured = { ...baseConfig().auth.sms, max_frequency: "1m" };
      const resolved = resolveAuthSms(undefined, configured, undefined);
      expect(resolved.max_frequency).toBe("5s");
      delete process.env["SUPABASE_AUTH_SMS_MAX_FREQUENCY"];
    });

    it("still aborts resolveLocalConfigValues on a malformed SUPABASE_AUTH_SMS_ENABLE_SIGNUP reached via validateAuthSmsProviders, unless remoteOverrideKeys suppresses it", () => {
      process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = "not-a-bool";
      const base = baseConfig();
      const config: CliConfig = {
        ...base,
        auth: {
          ...base.auth,
          enabled: true,
          sms: {
            ...base.auth.sms,
            enable_signup: true,
            vonage: {
              ...base.auth.sms.vonage,
              enabled: true,
              from: "12345",
              api_key: "key",
              api_secret: "secret",
            },
          },
        },
      };
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        'cannot parse "not-a-bool" as a bool',
      );
      expect(() =>
        resolveLocalConfigValues(
          config,
          "127.0.0.1",
          WORKDIR,
          undefined,
          undefined,
          new Set(["auth.sms.enable_signup"]),
        ),
      ).not.toThrow();
    });
  });

  describe("api.tls (cert/key validation)", () => {
    const tempRoot = useTempWorkdir("supabase-api-tls-test-");

    function writeTlsFile(workdir: string, name: string, contents = "dummy") {
      const supabaseDir = join(workdir, "supabase");
      mkdirSync(supabaseDir, { recursive: true });
      writeFileSync(join(supabaseDir, name), contents);
    }

    it("does not throw when tls.enabled with neither cert_path nor key_path set", () => {
      const config = baseConfig({ api: { tls: { enabled: true } } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    // The "exactly one of cert/key set" checks live in config-validate.unit.test.ts; the file-read
    // behavior below is tested here.

    it("throws a Go-worded error when the configured cert file does not exist", () => {
      writeTlsFile(tempRoot.current, "key.pem");
      const config = baseConfig({
        api: { tls: { enabled: true, cert_path: "missing-cert.pem", key_path: "key.pem" } },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to read TLS cert: ",
      );
    });

    it("throws a Go-worded error when the configured key file does not exist", () => {
      writeTlsFile(tempRoot.current, "cert.pem");
      const config = baseConfig({
        api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "missing-key.pem" } },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to read TLS key: ",
      );
    });

    it("succeeds when both cert_path and key_path are readable", () => {
      writeTlsFile(tempRoot.current, "cert.pem");
      writeTlsFile(tempRoot.current, "key.pem");
      const config = baseConfig({
        api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "key.pem" } },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("resolves cert_path/key_path against <workdir>/supabase unconditionally, no isAbsolute guard", () => {
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
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
    });

    it("skips TLS validation entirely when api is disabled", () => {
      const config = baseConfig({
        api: { enabled: false, tls: { enabled: true, cert_path: "missing-cert.pem" } },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
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
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).not.toThrow();
      });

      it("validates TLS when enabled only via env despite TOML saying tls.enabled = false", () => {
        process.env["SUPABASE_API_TLS_ENABLED"] = "true";
        const config = baseConfig({
          api: { tls: { enabled: false, cert_path: "missing-cert.pem" } },
        });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
          "Missing required field in config: api.tls.key_path",
        );
      });
    });
  });
});

describe("resolveLocalConfigValues — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
  // Once a remote block sets a field, a conflicting `SUPABASE_*` env var must not be consulted
  // for it — verified per field below.
  afterEach(() => {
    for (const name of [
      "SUPABASE_DB_MAJOR_VERSION",
      "SUPABASE_AUTH_JWT_SECRET",
      "SUPABASE_DB_ROOT_KEY",
      "SUPABASE_API_PORT",
      "SUPABASE_API_TLS_ENABLED",
      "SUPABASE_API_EXTERNAL_URL",
      "SUPABASE_DB_PORT",
      "SUPABASE_AUTH_SITE_URL",
      "SUPABASE_AUTH_JWT_EXPIRY",
      "SUPABASE_AUTH_ANON_KEY",
      "SUPABASE_AUTH_SERVICE_ROLE_KEY",
      "SUPABASE_STUDIO_API_URL",
      "SUPABASE_STUDIO_OPENAI_API_KEY",
      "SUPABASE_AUTH_PUBLISHABLE_KEY",
      "SUPABASE_AUTH_SECRET_KEY",
      "SUPABASE_DB_SETTINGS_MAX_CONNECTIONS",
      "SUPABASE_AUTH_SIGNING_KEYS_PATH",
      "SUPABASE_AUTH_ENABLED",
      "SUPABASE_ANALYTICS_ENABLED",
      "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED",
      "SUPABASE_AUTH_THIRD_PARTY_CLERK_ENABLED",
      "SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN",
      "SUPABASE_EDGE_RUNTIME_DENO_VERSION",
      "SUPABASE_API_ENABLED",
      "SUPABASE_STUDIO_ENABLED",
      "SUPABASE_STUDIO_PORT",
      "SUPABASE_LOCAL_SMTP_ENABLED",
      "SUPABASE_LOCAL_SMTP_PORT",
      "SUPABASE_AUTH_ENABLE_SIGNUP",
      "SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS",
      "SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION",
      "SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL",
      "SUPABASE_AUTH_ENABLE_MANUAL_LINKING",
      "SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH",
      "SUPABASE_AUTH_PASSWORD_REQUIREMENTS",
      "SUPABASE_AUTH_PASSKEY_ENABLED",
      "SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED",
      "SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI",
    ]) {
      delete process.env[name];
    }
  });

  const tempRoot = useTempWorkdir("supabase-remote-signing-keys-test-");

  it("prefers a remote-set auth.signing_keys_path over a conflicting SUPABASE_AUTH_SIGNING_KEYS_PATH", () => {
    writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
    process.env["SUPABASE_AUTH_SIGNING_KEYS_PATH"] = "missing-file.json";
    const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        tempRoot.current,
        undefined,
        undefined,
        new Set(["auth.signing_keys_path"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a missing SUPABASE_AUTH_SIGNING_KEYS_PATH override when no remote block matched", () => {
    writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
    process.env["SUPABASE_AUTH_SIGNING_KEYS_PATH"] = "missing-file.json";
    const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
      "failed to read signing keys: ",
    );
  });

  it("suppresses a malformed SUPABASE_DB_MAJOR_VERSION when a remote block already set db.major_version", () => {
    process.env["SUPABASE_DB_MAJOR_VERSION"] = "abc";
    const config = baseConfig({ db: { major_version: 14 } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["db.major_version"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a malformed SUPABASE_DB_MAJOR_VERSION when no remote block matched", () => {
    process.env["SUPABASE_DB_MAJOR_VERSION"] = "abc";
    const config = baseConfig({ db: { major_version: 14 } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "Invalid db.major_version: abc",
    );
  });

  it("prefers a remote-set auth.jwt_secret over a conflicting SUPABASE_AUTH_JWT_SECRET", () => {
    process.env["SUPABASE_AUTH_JWT_SECRET"] = "env-supplied-secret-value-1234567890";
    const config = baseConfig({ auth: { jwt_secret: "remote-supplied-secret-1234567890" } });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["auth.jwt_secret"]),
    );
    expect(values.jwtSecret).toBe("remote-supplied-secret-1234567890");
  });

  it("prefers a remote-set db.root_key over a conflicting SUPABASE_DB_ROOT_KEY", () => {
    process.env["SUPABASE_DB_ROOT_KEY"] = "env-root-key";
    const config = baseConfig();
    const document = { db: { root_key: "remote-root-key" } };
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      document,
      new Set(["db.root_key"]),
    );
    expect(values.rootKey).toBe("remote-root-key");
  });

  it("prefers a remote-set auth.third_party.clerk.domain over a conflicting env override during validation", () => {
    process.env["SUPABASE_AUTH_THIRD_PARTY_CLERK_ENABLED"] = "false";
    process.env["SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN"] = "not-a-clerk-domain";
    const config = baseConfig({
      auth: {
        enabled: true,
        third_party: { clerk: { enabled: true, domain: "clerk.example.com" } },
      },
    });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["auth.third_party.clerk.enabled", "auth.third_party.clerk.domain"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a conflicting SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN when no remote block matched", () => {
    process.env["SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN"] = "not-a-clerk-domain";
    const config = baseConfig({
      auth: {
        enabled: true,
        third_party: { clerk: { enabled: true, domain: "clerk.example.com" } },
      },
    });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "Invalid config: auth.third_party.clerk has invalid domain",
    );
  });

  describe("api.tls.cert_path/key_path — remoteOverrideKeys (review: PRRT_kwDOErm0O86W8ZYk)", () => {
    const tempRoot = useTempWorkdir("supabase-api-tls-remote-test-");

    function writeTlsFile(workdir: string, name: string, contents = "dummy") {
      const supabaseDir = join(workdir, "supabase");
      mkdirSync(supabaseDir, { recursive: true });
      writeFileSync(join(supabaseDir, name), contents);
    }

    afterEach(() => {
      delete process.env["SUPABASE_API_TLS_CERT_PATH"];
      delete process.env["SUPABASE_API_TLS_KEY_PATH"];
    });

    it("prefers a remote-set api.tls.cert_path/key_path over a conflicting (missing-file) env override", () => {
      // The env vars point at files that don't exist; the load only succeeds if the remote-set
      // paths win instead.
      writeTlsFile(tempRoot.current, "cert.pem");
      writeTlsFile(tempRoot.current, "key.pem");
      process.env["SUPABASE_API_TLS_CERT_PATH"] = "missing-cert.pem";
      process.env["SUPABASE_API_TLS_KEY_PATH"] = "missing-key.pem";
      const config = baseConfig({
        api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "key.pem" } },
      });
      expect(() =>
        resolveLocalConfigValues(
          config,
          "127.0.0.1",
          tempRoot.current,
          undefined,
          undefined,
          new Set(["api.tls.cert_path", "api.tls.key_path"]),
        ),
      ).not.toThrow();
    });

    it("still uses the env override when no remote block matched", () => {
      writeTlsFile(tempRoot.current, "cert.pem");
      process.env["SUPABASE_API_TLS_CERT_PATH"] = "missing-cert.pem";
      const config = baseConfig({
        api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "cert.pem" } },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to read TLS cert: ",
      );
    });
  });

  it("prefers remote-set api.port/api.tls.enabled/api.external_url over conflicting env overrides", () => {
    process.env["SUPABASE_API_PORT"] = "9999";
    process.env["SUPABASE_API_TLS_ENABLED"] = "true";
    process.env["SUPABASE_API_EXTERNAL_URL"] = "https://env-should-not-win.test";
    const config = baseConfig({ api: { port: 54321, external_url: "", tls: { enabled: false } } });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["api.port", "api.tls.enabled", "api.external_url"]),
    );
    expect(values.apiUrl).toBe("http://127.0.0.1:54321");
  });

  it("prefers a remote-set db.port over a conflicting SUPABASE_DB_PORT", () => {
    process.env["SUPABASE_DB_PORT"] = "9999";
    const config = baseConfig({ db: { port: 54322 } });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["db.port"]),
    );
    expect(values.dbPort).toBe(54322);
    expect(values.dbUrl).toContain(":54322/postgres");
  });

  it("prefers remote-set auth.site_url/auth.jwt_expiry over conflicting env overrides", () => {
    process.env["SUPABASE_AUTH_SITE_URL"] = "https://env-should-not-win.test";
    process.env["SUPABASE_AUTH_JWT_EXPIRY"] = "9999";
    const config = baseConfig({ auth: { site_url: "https://remote.test", jwt_expiry: 3600 } });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["auth.site_url", "auth.jwt_expiry"]),
    );
    expect(values.authSiteUrl).toBe("https://remote.test");
    expect(values.authJwtExpiry).toBe(3600);
  });

  it("prefers remote-set auth.anon_key/auth.service_role_key over conflicting env overrides", () => {
    process.env["SUPABASE_AUTH_ANON_KEY"] = "env-anon-key";
    process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"] = "env-service-role-key";
    const config = baseConfig({
      auth: { anon_key: "remote-anon-key", service_role_key: "remote-service-role-key" },
    });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["auth.anon_key", "auth.service_role_key"]),
    );
    expect(values.anonKey).toBe("remote-anon-key");
    expect(values.serviceRoleKey).toBe("remote-service-role-key");
  });

  it("suppresses a malformed SUPABASE_STUDIO_API_URL when a remote block already set studio.api_url", () => {
    process.env["SUPABASE_STUDIO_API_URL"] = "http://[::1";
    const config = baseConfig({ studio: { api_url: "http://remote.test" } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["studio.api_url"]),
      ),
    ).not.toThrow();
  });

  it("prefers a remote-set studio.openai_api_key over a conflicting SUPABASE_STUDIO_OPENAI_API_KEY", () => {
    process.env["SUPABASE_STUDIO_OPENAI_API_KEY"] = "encrypted:not-a-real-ciphertext";
    const config = baseConfig({ studio: { openai_api_key: "remote-openai-key" } });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["studio.openai_api_key"]),
    );
    expect(values.openaiApiKey).toBe("remote-openai-key");
  });

  it("still rejects a malformed SUPABASE_STUDIO_OPENAI_API_KEY when no remote block matched", () => {
    process.env["SUPABASE_STUDIO_OPENAI_API_KEY"] = "encrypted:not-a-real-ciphertext";
    const config = baseConfig({ studio: { openai_api_key: "remote-openai-key" } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "failed to parse config: missing private key",
    );
  });

  it("prefers remote-set auth.publishable_key/auth.secret_key over conflicting env overrides", () => {
    process.env["SUPABASE_AUTH_PUBLISHABLE_KEY"] = "encrypted:not-a-real-ciphertext";
    process.env["SUPABASE_AUTH_SECRET_KEY"] = "encrypted:not-a-real-ciphertext";
    const config = baseConfig({
      auth: { publishable_key: "remote-publishable-key", secret_key: "remote-secret-key" },
    });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["auth.publishable_key", "auth.secret_key"]),
    );
    expect(values.publishableKey).toBe("remote-publishable-key");
    expect(values.secretKey).toBe("remote-secret-key");
  });

  it("still rejects a malformed SUPABASE_AUTH_PUBLISHABLE_KEY when no remote block matched", () => {
    process.env["SUPABASE_AUTH_PUBLISHABLE_KEY"] = "encrypted:not-a-real-ciphertext";
    const config = baseConfig({ auth: { publishable_key: "remote-publishable-key" } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "failed to parse config: missing private key",
    );
  });

  it("still rejects a malformed SUPABASE_AUTH_SECRET_KEY when no remote block matched", () => {
    process.env["SUPABASE_AUTH_SECRET_KEY"] = "encrypted:not-a-real-ciphertext";
    const config = baseConfig({ auth: { secret_key: "remote-secret-key" } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "failed to parse config: missing private key",
    );
  });

  it("suppresses a malformed SUPABASE_DB_SETTINGS_MAX_CONNECTIONS when the remote block set db.settings.max_connections", () => {
    process.env["SUPABASE_DB_SETTINGS_MAX_CONNECTIONS"] = "not-a-number";
    const config = baseConfig({ db: { settings: { max_connections: 100 } } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["db.settings.max_connections"]),
      ),
    ).not.toThrow();
  });

  it("suppresses a malformed SUPABASE_AUTH_ENABLED when a remote block already set auth.enabled", () => {
    process.env["SUPABASE_AUTH_ENABLED"] = "not-a-bool";
    const config = baseConfig({ auth: { enabled: false } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["auth.enabled"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a malformed SUPABASE_AUTH_ENABLED when no remote block matched", () => {
    process.env["SUPABASE_AUTH_ENABLED"] = "not-a-bool";
    const config = baseConfig({ auth: { enabled: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for auth.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_ANALYTICS_ENABLED when a remote block already set analytics.enabled", () => {
    process.env["SUPABASE_ANALYTICS_ENABLED"] = "not-a-bool";
    const config = baseConfig({ analytics: { enabled: false } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["analytics.enabled"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a malformed SUPABASE_ANALYTICS_ENABLED when no remote block matched", () => {
    process.env["SUPABASE_ANALYTICS_ENABLED"] = "not-a-bool";
    const config = baseConfig({ analytics: { enabled: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for analytics.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("prefers a remote-set analytics.gcp_project_id over a conflicting SUPABASE_ANALYTICS_GCP_PROJECT_ID", () => {
    process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"] = "env-project";
    const config = baseConfig({ analytics: { gcp_project_id: "remote-project" } });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["analytics.gcp_project_id"]),
    );
    expect(values.gcpProjectId).toBe("remote-project");
    delete process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"];
  });

  it("still applies SUPABASE_ANALYTICS_GCP_PROJECT_ID when no remote block matched", () => {
    process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"] = "env-project";
    const config = baseConfig({ analytics: { gcp_project_id: "remote-project" } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.gcpProjectId).toBe("env-project");
    delete process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"];
  });

  it("prefers a remote-set analytics.gcp_project_number over a conflicting SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER", () => {
    process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"] = "999";
    const config = baseConfig({ analytics: { gcp_project_number: "111" } });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["analytics.gcp_project_number"]),
    );
    expect(values.gcpProjectNumber).toBe("111");
    delete process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"];
  });

  it("still applies SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER when no remote block matched", () => {
    process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"] = "999";
    const config = baseConfig({ analytics: { gcp_project_number: "111" } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.gcpProjectNumber).toBe("999");
    delete process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"];
  });

  it("prefers a remote-set analytics.gcp_jwt_path over a conflicting SUPABASE_ANALYTICS_GCP_JWT_PATH", () => {
    process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"] = "env-key.json";
    const config = baseConfig({ analytics: { gcp_jwt_path: "remote-key.json" } });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["analytics.gcp_jwt_path"]),
    );
    expect(values.gcpJwtPath).toBe("remote-key.json");
    delete process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"];
  });

  it("still applies SUPABASE_ANALYTICS_GCP_JWT_PATH when no remote block matched", () => {
    process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"] = "env-key.json";
    const config = baseConfig({ analytics: { gcp_jwt_path: "remote-key.json" } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.gcpJwtPath).toBe("env-key.json");
    delete process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"];
  });

  it("prefers a remote-set auth.jwt_issuer over a conflicting SUPABASE_AUTH_JWT_ISSUER", () => {
    process.env["SUPABASE_AUTH_JWT_ISSUER"] = "https://env.example.com";
    const config = baseConfig({ auth: { jwt_issuer: "https://remote.example.com" } });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["auth.jwt_issuer"]),
    );
    expect(values.authJwtIssuer).toBe("https://remote.example.com");
    delete process.env["SUPABASE_AUTH_JWT_ISSUER"];
  });

  it("still applies SUPABASE_AUTH_JWT_ISSUER when no remote block matched", () => {
    process.env["SUPABASE_AUTH_JWT_ISSUER"] = "https://env.example.com";
    const config = baseConfig({ auth: { jwt_issuer: "https://remote.example.com" } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.authJwtIssuer).toBe("https://env.example.com");
    delete process.env["SUPABASE_AUTH_JWT_ISSUER"];
  });

  it("prefers a remote-set auth.additional_redirect_urls over a conflicting SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS", () => {
    process.env["SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS"] = "https://env.example.com";
    const config = baseConfig({
      auth: { additional_redirect_urls: ["https://remote.example.com"] },
    });
    const values = resolveLocalConfigValues(
      config,
      "127.0.0.1",
      WORKDIR,
      undefined,
      undefined,
      new Set(["auth.additional_redirect_urls"]),
    );
    expect(values.authAdditionalRedirectUrls).toEqual(["https://remote.example.com"]);
    delete process.env["SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS"];
  });

  it("still applies SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS when no remote block matched", () => {
    process.env["SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS"] = "https://env.example.com";
    const config = baseConfig({
      auth: { additional_redirect_urls: ["https://remote.example.com"] },
    });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.authAdditionalRedirectUrls).toEqual(["https://env.example.com"]);
    delete process.env["SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS"];
  });

  describe("auth.webauthn.rp_id / auth.webauthn.rp_origins — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
    // rpId/rpOrigins aren't part of the return value, so precedence is proven through
    // validateResolvedConfig's own emptiness check on a document that leaves the field present
    // but empty.
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_PASSKEY_ENABLED"];
      delete process.env["SUPABASE_AUTH_WEBAUTHN_RP_ID"];
      delete process.env["SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS"];
    });

    it("suppresses a non-empty SUPABASE_AUTH_WEBAUTHN_RP_ID when a remote block already set (empty) auth.webauthn.rp_id", () => {
      process.env["SUPABASE_AUTH_WEBAUTHN_RP_ID"] = "localhost";
      const config = baseConfig();
      const document = {
        auth: { passkey: { enabled: true }, webauthn: { rp_id: "", rp_origins: ["http://x"] } },
      };
      expect(() =>
        resolveLocalConfigValues(
          config,
          "127.0.0.1",
          WORKDIR,
          undefined,
          document,
          new Set(["auth.webauthn.rp_id"]),
        ),
      ).toThrow("Missing required field in config: auth.webauthn.rp_id");
    });

    it("still applies SUPABASE_AUTH_WEBAUTHN_RP_ID when no remote block matched", () => {
      process.env["SUPABASE_AUTH_WEBAUTHN_RP_ID"] = "localhost";
      const config = baseConfig();
      const document = {
        auth: { passkey: { enabled: true }, webauthn: { rp_id: "", rp_origins: ["http://x"] } },
      };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("suppresses a non-empty SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS when a remote block already set (empty) auth.webauthn.rp_origins", () => {
      process.env["SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS"] = "http://localhost:3000";
      const config = baseConfig();
      const document = {
        auth: { passkey: { enabled: true }, webauthn: { rp_id: "localhost", rp_origins: [] } },
      };
      expect(() =>
        resolveLocalConfigValues(
          config,
          "127.0.0.1",
          WORKDIR,
          undefined,
          document,
          new Set(["auth.webauthn.rp_origins"]),
        ),
      ).toThrow("Missing required field in config: auth.webauthn.rp_origins");
    });

    it("still applies SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS when no remote block matched", () => {
      process.env["SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS"] = "http://localhost:3000";
      const config = baseConfig();
      const document = {
        auth: { passkey: { enabled: true }, webauthn: { rp_id: "localhost", rp_origins: [] } },
      };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });
  });

  it("suppresses a malformed SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED when a remote block already set auth.third_party.firebase.enabled", () => {
    process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED"] = "not-a-bool";
    const config = baseConfig({
      auth: { enabled: true, third_party: { firebase: { enabled: false } } },
    });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["auth.enabled", "auth.third_party.firebase.enabled"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a malformed SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED when no remote block matched", () => {
    process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED"] = "not-a-bool";
    const config = baseConfig({
      auth: { enabled: true, third_party: { firebase: { enabled: false } } },
    });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for auth.third_party.firebase.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_EDGE_RUNTIME_DENO_VERSION when a remote block already set edge_runtime.deno_version", () => {
    process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "abc";
    const config = baseConfig({ edge_runtime: { deno_version: 2 } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["edge_runtime.deno_version"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a malformed SUPABASE_EDGE_RUNTIME_DENO_VERSION when no remote block matched", () => {
    process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "abc";
    const config = baseConfig({ edge_runtime: { deno_version: 2 } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "Failed reading config: Invalid edge_runtime.deno_version: abc.",
    );
  });

  it("suppresses a malformed SUPABASE_API_ENABLED when a remote block already set api.enabled", () => {
    process.env["SUPABASE_API_ENABLED"] = "not-a-bool";
    const config = baseConfig({ api: { enabled: false } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["api.enabled"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a malformed SUPABASE_API_ENABLED when no remote block matched", () => {
    process.env["SUPABASE_API_ENABLED"] = "not-a-bool";
    const config = baseConfig({ api: { enabled: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for api.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_STUDIO_ENABLED when a remote block already set studio.enabled", () => {
    process.env["SUPABASE_STUDIO_ENABLED"] = "not-a-bool";
    const config = baseConfig({ studio: { enabled: false } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["studio.enabled"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a malformed SUPABASE_STUDIO_ENABLED when no remote block matched", () => {
    process.env["SUPABASE_STUDIO_ENABLED"] = "not-a-bool";
    const config = baseConfig({ studio: { enabled: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for studio.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_STUDIO_PORT when a remote block already set studio.port", () => {
    process.env["SUPABASE_STUDIO_PORT"] = "not-a-port";
    const config = baseConfig({ studio: { port: 54323 } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["studio.port"]),
      ),
    ).not.toThrow();
  });

  it("suppresses a malformed SUPABASE_LOCAL_SMTP_ENABLED when a remote block already set local_smtp.enabled", () => {
    process.env["SUPABASE_LOCAL_SMTP_ENABLED"] = "not-a-bool";
    const config = baseConfig({ local_smtp: { enabled: false } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["local_smtp.enabled"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a malformed SUPABASE_LOCAL_SMTP_ENABLED when no remote block matched", () => {
    process.env["SUPABASE_LOCAL_SMTP_ENABLED"] = "not-a-bool";
    const config = baseConfig({ local_smtp: { enabled: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for local_smtp.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_AUTH_ENABLE_SIGNUP when a remote block already set auth.enable_signup", () => {
    process.env["SUPABASE_AUTH_ENABLE_SIGNUP"] = "not-a-bool";
    const config = baseConfig({ auth: { enable_signup: false } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["auth.enable_signup"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a malformed SUPABASE_AUTH_ENABLE_SIGNUP when no remote block matched", () => {
    process.env["SUPABASE_AUTH_ENABLE_SIGNUP"] = "not-a-bool";
    const config = baseConfig({ auth: { enable_signup: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for auth.enable_signup: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH when a remote block already set auth.minimum_password_length", () => {
    process.env["SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH"] = "not-a-number";
    const config = baseConfig({ auth: { minimum_password_length: 8 } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["auth.minimum_password_length"]),
      ),
    ).not.toThrow();
  });

  it("suppresses a malformed SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED when a remote block already set experimental.webhooks.enabled", () => {
    process.env["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"] = "not-a-bool";
    const config = baseConfig({ experimental: { webhooks: { enabled: true } } });
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        undefined,
        new Set(["experimental.webhooks.enabled"]),
      ),
    ).not.toThrow();
  });

  it("suppresses a scheme-invalid SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI when a remote block already set that hook's uri", () => {
    process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI"] = "ftp://example.com";
    const config = baseConfig({
      auth: {
        hook: {
          custom_access_token: {
            enabled: true,
            uri: "https://example.com/hook",
            secrets: `v1,whsec_${"A".repeat(32)}`,
          },
        },
      },
    });
    const document = { auth: { hook: { custom_access_token: { enabled: true } } } };
    expect(() =>
      resolveLocalConfigValues(
        config,
        "127.0.0.1",
        WORKDIR,
        undefined,
        document,
        new Set(["auth.hook.custom_access_token.uri"]),
      ),
    ).not.toThrow();
  });

  it("still rejects a scheme-invalid SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI when no remote block matched that leaf", () => {
    process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI"] = "ftp://example.com";
    const config = baseConfig({
      auth: {
        hook: {
          custom_access_token: { enabled: true, uri: "https://example.com/hook", secrets: "" },
        },
      },
    });
    const document = { auth: { hook: { custom_access_token: { enabled: true } } } };
    expect(() =>
      resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
    ).toThrow("auth.hook.custom_access_token.uri should be a HTTP, HTTPS, or pg-functions URI");
  });
});

describe("resolveLocalJwks", () => {
  const tempRoot = useTempWorkdir("supabase-local-jwks-test-");

  it("includes the default ES256 signing key and the oct JWT-secret fallback when no signing_keys_path is configured", async () => {
    const config = baseConfig();
    const jwks = await resolveLocalJwks(config, tempRoot.current, "a".repeat(32));
    expect(JSON.parse(jwks)).toEqual({
      keys: [
        {
          kty: "EC",
          kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
          use: "sig",
          key_ops: ["verify"],
          alg: "ES256",
          ext: true,
          crv: "P-256",
          x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
          y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
        },
        { kty: "oct", k: Buffer.from("a".repeat(32)).toString("base64url") },
      ],
    });
  });

  it("publishes the public form of every signing key and omits the oct fallback", async () => {
    const jwk = generateRsaJwk();
    writeSigningKeys(tempRoot.current, [jwk]);
    const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
    const jwks = await resolveLocalJwks(config, tempRoot.current, "a".repeat(32));
    const parsed = JSON.parse(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };

    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]).toMatchObject({
      kty: "RSA",
      kid: "test-rsa-kid",
      n: jwk["n"],
      e: jwk["e"],
    });
    expect(parsed.keys[0]).not.toHaveProperty("d");
    expect(parsed.keys[0]).not.toHaveProperty("p");
    expect(parsed.keys.some((key) => key["kty"] === "oct")).toBe(false);
  });

  it("preserves a configured signing key's use/ext and filters key_ops to verify-only", async () => {
    const jwk = { ...generateRsaJwk(), use: "sig", ext: true, key_ops: ["sign", "verify"] };
    writeSigningKeys(tempRoot.current, [jwk]);
    const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
    const jwks = await resolveLocalJwks(config, tempRoot.current, "a".repeat(32));
    const parsed = JSON.parse(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };

    expect(parsed.keys[0]).toMatchObject({ use: "sig", ext: true, key_ops: ["verify"] });
  });

  it("falls back to the default ES256 signing key (not the configured file, not the oct fallback) when auth is disabled but signing_keys_path is set", async () => {
    writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
    const config = baseConfig({
      auth: { enabled: false, signing_keys_path: "signing_keys.json" },
    });
    const jwks = await resolveLocalJwks(config, tempRoot.current, "a".repeat(32));
    expect(JSON.parse(jwks)).toEqual({
      keys: [
        {
          kty: "EC",
          kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
          use: "sig",
          key_ops: ["verify"],
          alg: "ES256",
          ext: true,
          crv: "P-256",
          x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
          y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
        },
      ],
    });
  });

  it("throws a Go-worded error when the signing keys file does not exist", async () => {
    const config = baseConfig({ auth: { signing_keys_path: "missing.json" } });
    await expect(resolveLocalJwks(config, tempRoot.current, "a".repeat(32))).rejects.toThrow(
      "failed to read signing keys: ",
    );
  });

  it("throws a Go-worded error when the signing keys file is malformed JSON", async () => {
    const supabaseDir = join(tempRoot.current, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    writeFileSync(join(supabaseDir, "signing_keys.json"), "not valid json");
    const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
    await expect(resolveLocalJwks(config, tempRoot.current, "a".repeat(32))).rejects.toThrow(
      "failed to decode signing keys: ",
    );
  });

  describe("auth.third_party", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("rejects an enabled third-party provider missing its required field", async () => {
      const config = baseConfig({ auth: { third_party: { firebase: { enabled: true } } } });
      await expect(resolveLocalJwks(config, WORKDIR, "a".repeat(32))).rejects.toThrow(
        "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
      );
    });

    it("rejects more than one enabled third-party provider", async () => {
      const config = baseConfig({
        auth: {
          third_party: {
            firebase: { enabled: true, project_id: "my-project" },
            workos: { enabled: true, issuer_url: "https://issuer.example" },
          },
        },
      });
      await expect(resolveLocalJwks(config, WORKDIR, "a".repeat(32))).rejects.toThrow(
        "Invalid config: Only one third_party provider allowed to be enabled at a time.",
      );
    });

    it("does not validate third-party providers when auth is disabled, matching Go's ResolveJWKS/IssuerURL", async () => {
      const remoteKeys = [{ kty: "RSA", kid: "firebase-key", n: "abc", e: "AQAB" }];
      const issuerUrl = "https://securetoken.google.com/my-project";
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === `${issuerUrl}/.well-known/openid-configuration`) {
          return new Response(JSON.stringify({ jwks_uri: `${issuerUrl}/jwks.json` }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === `${issuerUrl}/jwks.json`) {
          return new Response(JSON.stringify({ keys: remoteKeys }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      const config = baseConfig({
        auth: {
          enabled: false,
          third_party: {
            firebase: { enabled: true, project_id: "my-project" },
            workos: { enabled: true, issuer_url: "https://issuer.example" },
          },
        },
      });
      const jwksJson = await resolveLocalJwks(config, WORKDIR, "a".repeat(32));
      const jwks = JSON.parse(jwksJson) as { keys: ReadonlyArray<{ kid?: string }> };
      expect(jwks.keys.some((key) => key.kid === "firebase-key")).toBe(true);
      fetchMock.mockRestore();
    });

    it('does not attempt a remote JWKS fetch for an enabled third-party provider with an empty issuer_url, matching Go\'s issuerURL != "" check', async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const config = baseConfig({
        auth: {
          enabled: false,
          third_party: { workos: { enabled: true, issuer_url: "" } },
        },
      });

      const jwksJson = await resolveLocalJwks(config, WORKDIR, "a".repeat(32));
      const jwks = JSON.parse(jwksJson) as { keys: ReadonlyArray<unknown> };

      expect(fetchMock).not.toHaveBeenCalled();
      expect(jwks.keys.length).toBeGreaterThan(0);
      fetchMock.mockRestore();
    });

    it("fetches and includes the remote JWKS for an enabled third-party provider", async () => {
      const remoteKeys = [{ kty: "RSA", kid: "remote-key", n: "abc", e: "AQAB" }];
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://issuer.example/.well-known/openid-configuration") {
          return new Response(JSON.stringify({ jwks_uri: "https://issuer.example/jwks.json" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "https://issuer.example/jwks.json") {
          return new Response(JSON.stringify({ keys: remoteKeys }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch url: ${url}`);
      });

      const config = baseConfig({
        auth: { third_party: { workos: { enabled: true, issuer_url: "https://issuer.example" } } },
      });
      const jwks = await resolveLocalJwks(config, WORKDIR, "a".repeat(32));
      const parsed = JSON.parse(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };

      expect(parsed.keys).toEqual(
        expect.arrayContaining([expect.objectContaining({ kid: "remote-key" })]),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("fails the whole resolution when the remote JWKS fetch fails, unlike functions serve's leniency", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        throw new Error("oidc discovery failed");
      });

      const config = baseConfig({
        auth: { third_party: { workos: { enabled: true, issuer_url: "https://issuer.example" } } },
      });
      await expect(resolveLocalJwks(config, WORKDIR, "a".repeat(32))).rejects.toThrow(
        "oidc discovery failed",
      );
    });
  });

  describe("remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
    afterEach(() => {
      for (const name of [
        "SUPABASE_AUTH_SIGNING_KEYS_PATH",
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED",
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL",
        "SUPABASE_AUTH_ENABLED",
      ]) {
        delete process.env[name];
      }
    });

    it("prefers a remote-set auth.signing_keys_path over a conflicting SUPABASE_AUTH_SIGNING_KEYS_PATH", async () => {
      writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
      process.env["SUPABASE_AUTH_SIGNING_KEYS_PATH"] = "missing-file.json";
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const jwks = await resolveLocalJwks(
        config,
        tempRoot.current,
        "a".repeat(32),
        undefined,
        new Set(["auth.signing_keys_path"]),
      );
      const parsed = JSON.parse(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };
      expect(parsed.keys).toHaveLength(1);
      expect(parsed.keys[0]).toMatchObject({ kty: "RSA", kid: "test-rsa-kid" });
    });

    it("still rejects a missing SUPABASE_AUTH_SIGNING_KEYS_PATH override when no remote block matched", async () => {
      writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
      process.env["SUPABASE_AUTH_SIGNING_KEYS_PATH"] = "missing-file.json";
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      await expect(resolveLocalJwks(config, tempRoot.current, "a".repeat(32))).rejects.toThrow(
        "failed to read signing keys: ",
      );
    });

    it("prefers a remote-set auth.third_party.workos.* over conflicting env overrides", async () => {
      const remoteKeys = [{ kty: "RSA", kid: "remote-key", n: "abc", e: "AQAB" }];
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://remote-issuer.example/.well-known/openid-configuration") {
          return new Response(
            JSON.stringify({ jwks_uri: "https://remote-issuer.example/jwks.json" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "https://remote-issuer.example/jwks.json") {
          return new Response(JSON.stringify({ keys: remoteKeys }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch url: ${url}`);
      });
      process.env["SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED"] = "false";
      process.env["SUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL"] =
        "https://env-should-not-win.test";
      const config = baseConfig({
        auth: {
          third_party: { workos: { enabled: true, issuer_url: "https://remote-issuer.example" } },
        },
      });
      const jwks = await resolveLocalJwks(
        config,
        WORKDIR,
        "a".repeat(32),
        undefined,
        new Set(["auth.third_party.workos.enabled", "auth.third_party.workos.issuer_url"]),
      );
      const parsed = JSON.parse(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };
      expect(parsed.keys.some((key) => key["kid"] === "remote-key")).toBe(true);
      fetchMock.mockRestore();
    });

    it("suppresses a malformed SUPABASE_AUTH_ENABLED when a remote block already set auth.enabled", async () => {
      process.env["SUPABASE_AUTH_ENABLED"] = "not-a-bool";
      const config = baseConfig({ auth: { enabled: false } });
      await expect(
        resolveLocalJwks(config, WORKDIR, "a".repeat(32), undefined, new Set(["auth.enabled"])),
      ).resolves.toEqual(expect.any(String));
    });

    it("still rejects a malformed SUPABASE_AUTH_ENABLED when no remote block matched", async () => {
      process.env["SUPABASE_AUTH_ENABLED"] = "not-a-bool";
      const config = baseConfig({ auth: { enabled: false } });
      await expect(resolveLocalJwks(config, WORKDIR, "a".repeat(32))).rejects.toThrow(
        'Invalid config for auth.enabled: cannot parse "not-a-bool" as a bool',
      );
    });
  });
});

describe("resolveAuthExternalUrl — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
  afterEach(() => {
    delete process.env["SUPABASE_AUTH_EXTERNAL_URL"];
  });

  it("prefers a remote-set auth.external_url over a conflicting SUPABASE_AUTH_EXTERNAL_URL", () => {
    process.env["SUPABASE_AUTH_EXTERNAL_URL"] = "https://env-should-not-win.test";
    const document = { auth: { external_url: "https://remote.test" } };
    expect(resolveAuthExternalUrl(document, undefined, new Set(["auth.external_url"]))).toBe(
      "https://remote.test",
    );
  });

  it("still applies SUPABASE_AUTH_EXTERNAL_URL when no remote block matched", () => {
    process.env["SUPABASE_AUTH_EXTERNAL_URL"] = "https://env-wins.test";
    const document = { auth: { external_url: "https://configured.test" } };
    expect(resolveAuthExternalUrl(document, undefined)).toBe("https://env-wins.test");
  });
});

describe("resolveConfiguredSigningKeys — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
  const tempRoot = useTempWorkdir("supabase-configured-signing-keys-test-");

  afterEach(() => {
    delete process.env["SUPABASE_AUTH_SIGNING_KEYS_PATH"];
    delete process.env["SUPABASE_AUTH_ENABLED"];
  });

  it("prefers a remote-set auth.signing_keys_path over a conflicting SUPABASE_AUTH_SIGNING_KEYS_PATH", () => {
    const jwk = generateRsaJwk();
    writeSigningKeys(tempRoot.current, [jwk]);
    process.env["SUPABASE_AUTH_SIGNING_KEYS_PATH"] = "missing-file.json";
    const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
    const keys = resolveConfiguredSigningKeys(
      config,
      tempRoot.current,
      undefined,
      new Set(["auth.signing_keys_path"]),
    );
    expect(keys).toHaveLength(1);
    expect(keys?.[0]).toMatchObject({ kid: "test-rsa-kid" });
  });

  it("still reads the env-overridden path when no remote block matched", () => {
    const jwk = generateRsaJwk();
    writeSigningKeys(tempRoot.current, [jwk]);
    process.env["SUPABASE_AUTH_SIGNING_KEYS_PATH"] = "missing-file.json";
    const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
    expect(() => resolveConfiguredSigningKeys(config, tempRoot.current, undefined)).toThrow(
      "failed to read signing keys: ",
    );
  });

  it("suppresses a malformed SUPABASE_AUTH_ENABLED when a remote block already set auth.enabled", () => {
    process.env["SUPABASE_AUTH_ENABLED"] = "not-a-bool";
    const config = baseConfig({ auth: { enabled: false } });
    expect(() =>
      resolveConfiguredSigningKeys(config, tempRoot.current, undefined, new Set(["auth.enabled"])),
    ).not.toThrow();
  });

  it("still rejects a malformed SUPABASE_AUTH_ENABLED when no remote block matched", () => {
    process.env["SUPABASE_AUTH_ENABLED"] = "not-a-bool";
    const config = baseConfig({ auth: { enabled: false } });
    expect(() => resolveConfiguredSigningKeys(config, tempRoot.current, undefined)).toThrow(
      'Invalid config for auth.enabled: cannot parse "not-a-bool" as a bool',
    );
  });
});
