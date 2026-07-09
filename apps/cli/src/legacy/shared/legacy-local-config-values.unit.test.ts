import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ProjectConfigSchema, type ProjectConfig } from "@supabase/config";
import { Schema } from "effect";
import { importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyInvalidAnalyticsBackendEnvOverrideError,
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

  describe("encrypted auth secrets", () => {
    // Go's test vector (`apps/cli-go/pkg/config/secret_test.go`): this ciphertext
    // decrypts to "value" under the keypair below.
    const VAULT_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
    const VAULT_ENCRYPTED =
      "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

    afterEach(() => {
      delete process.env["DOTENV_PRIVATE_KEY"];
    });

    it("decrypts an encrypted: jwt_secret when DOTENV_PRIVATE_KEY is set", () => {
      // "value" is only 5 characters, shorter than Go's minimum JWT secret length,
      // so pad it out the way a real deployment's decrypted secret would be sized.
      process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
      const config = baseConfig({ auth: { jwt_secret: VAULT_ENCRYPTED } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        LegacyInvalidJwtSecretError,
      );
    });

    it("decrypts an encrypted: publishable_key when DOTENV_PRIVATE_KEY is set", () => {
      process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
      const config = baseConfig({ auth: { publishable_key: VAULT_ENCRYPTED } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.publishableKey).toBe("value");
    });

    it("fails config loading for an encrypted: secret with no private key, matching Go", () => {
      // Go aborts the whole command with `failed to parse config: <error>` rather
      // than silently using the ciphertext as literal key material
      // (`secret.go:30-73`, `config.go:704`).
      const config = baseConfig({ auth: { publishable_key: VAULT_ENCRYPTED } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "failed to parse config: missing private key",
      );
    });

    it("decrypts an encrypted: SUPABASE_AUTH_* env override, not just the config.toml value", () => {
      // Go's decrypt hook runs on whatever value reaches the config.Secret field,
      // whether it was sourced from config.toml or a Viper env override.
      process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
      const config = baseConfig();
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, {
        SUPABASE_AUTH_SECRET_KEY: VAULT_ENCRYPTED,
      });
      expect(values.secretKey).toBe("value");
      delete process.env["DOTENV_PRIVATE_KEY"];
    });
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

  it("does not reject an absent project_id when the workdir basename sanitizes to a non-empty value", () => {
    const config = Schema.decodeUnknownSync(ProjectConfigSchema)({});
    expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
  });

  it("rejects an absent project_id when the workdir basename sanitizes to empty, matching Go", () => {
    // Go's `mergeDefaultValues` merges `sanitizeProjectId(filepath.Base(cwd))` in as a viper
    // DEFAULT before config.toml is merged (config.go:690-699, via Eject at config.go:561-570) —
    // so `c.ProjectId` is never Go's zero value by the time `Validate` runs. A workdir whose
    // basename sanitizes to `""` (every character invalid, e.g. `!!!`) therefore still fails
    // config loading in Go even with no `project_id` key in the file at all.
    const config = Schema.decodeUnknownSync(ProjectConfigSchema)({});
    expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", "/tmp/!!!")).toThrow(
      "Missing required field in config: project_id",
    );
  });

  it("lets SUPABASE_PROJECT_ID override an absent project_id whose basename sanitizes to empty", () => {
    const config = Schema.decodeUnknownSync(ProjectConfigSchema)({});
    expect(() =>
      legacyResolveLocalConfigValues(config, "127.0.0.1", "/tmp/!!!", {
        SUPABASE_PROJECT_ID: "env-project",
      }),
    ).not.toThrow();
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

  describe("SUPABASE_* env(VAR) indirection (Go's LoadEnvHook)", () => {
    // Go's `LoadEnvHook` (`apps/cli-go/pkg/config/decode_hooks.go:15-23`) is
    // the first mapstructure decode hook composed into `v.UnmarshalExact`
    // (`config.go:749-753,769-772`), so it resolves a nested `env(VAR)`
    // reference on ANY string mapstructure decodes into the struct — including
    // a `SUPABASE_*` env-override value itself, not just a `config.toml`
    // literal. `envOverride`'s callers (string/port/bool fields) must all see
    // that same resolution.
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
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.jwtSecret).toBe("c".repeat(32));
    });

    it("resolves a port override's env(VAR) indirection", () => {
      process.env["SUPABASE_DB_PORT"] = "env(INDIRECT_DB_PORT)";
      process.env["INDIRECT_DB_PORT"] = "54329";
      const config = baseConfig({ db: { port: 54322 } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54329/postgres");
    });

    it("resolves a bool override's env(VAR) indirection", () => {
      process.env["SUPABASE_API_ENABLED"] = "env(INDIRECT_API_ENABLED)";
      process.env["INDIRECT_API_ENABLED"] = "false";
      const config = baseConfig({
        api: { enabled: true, tls: { enabled: true, cert_path: "missing-cert.pem" } },
      });
      // If the bool override weren't resolved through the indirection, the
      // literal "env(INDIRECT_API_ENABLED)" string would fail Go's
      // strconv.ParseBool acceptance set and throw LegacyInvalidBoolEnvOverrideError;
      // resolving it to "false" disables api.enabled and skips the TLS check
      // that would otherwise throw on the missing cert file.
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("preserves the env(VAR) literal when the indirected var is unset, matching Go", () => {
      process.env["SUPABASE_AUTH_JWT_SECRET"] = "env(INDIRECT_JWT_SECRET)";
      const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
      const values = legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      // Go's LoadEnvHook only substitutes when the target var is non-empty
      // (`decode_hooks.go:19-24`) — an unset indirection leaves the literal
      // `env(VAR)` string, same as an unresolved config.toml-level reference.
      expect(values.jwtSecret).toBe("env(INDIRECT_JWT_SECRET)");
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
      "SUPABASE_STUDIO_API_URL",
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

    // Go's Config.Validate parses studio.api_url with net/url.Parse right
    // after the port check, still inside `if c.Studio.Enabled`
    // (pkg/config/config.go:1074-1078).
    it("rejects a malformed studio.api_url (unterminated IPv6 literal) when studio is enabled", () => {
      const config = baseConfig({ studio: { api_url: "http://[::1" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        `Invalid config for studio.api_url: parse "http://[::1": missing ']' in host`,
      );
    });

    it("does not reject a malformed studio.api_url when studio is disabled", () => {
      const config = baseConfig({ studio: { enabled: false, api_url: "http://[::1" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not throw for the default studio.api_url", () => {
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects a malformed SUPABASE_STUDIO_API_URL override", () => {
      process.env["SUPABASE_STUDIO_API_URL"] = "http://[::1";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        `Invalid config for studio.api_url: parse "http://[::1": missing ']' in host`,
      );
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
    // The pure 0/12/13-17/generic-invalid assertions moved to
    // `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig` calls) —
    // only the SUPABASE_DB_MAJOR_VERSION env-override mechanics stay here.
    afterEach(() => {
      delete process.env["SUPABASE_DB_MAJOR_VERSION"];
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
  //
  // Moved to `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig`
  // calls) — this section has no L-specific derivation or env-override mechanics of its own.

  // Go's Config.Validate rejects an invalid edge_runtime.deno_version
  // unconditionally — NOT gated on edge_runtime.enabled
  // (pkg/config/config.go:1164-1173).
  describe("edge_runtime.deno_version (required field in config)", () => {
    // The pure 0/1/2/generic-invalid/disabled assertions moved to
    // `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig` calls) —
    // only the SUPABASE_EDGE_RUNTIME_DENO_VERSION env-override mechanics stay here.
    afterEach(() => {
      delete process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
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
  });

  describe("analytics (BigQuery backend required fields)", () => {
    // Go's `Config.Validate` validates `[analytics]` right after
    // `edge_runtime.deno_version` (`pkg/config/config.go:1174-1187`): when
    // `analytics.enabled` and `analytics.backend == "bigquery"`, all three GCP
    // fields are required, checked in that order.
    //
    // The pure required-field/complete/disabled assertions moved to
    // `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig` calls) —
    // only the SUPABASE_ANALYTICS_* env-override mechanics stay here.
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

    // Go's `LogflareBackend.UnmarshalText` (`config.go:60-65`) hard-rejects any
    // `analytics.backend` value outside `postgres`/`bigquery` during the same
    // `UnmarshalExact` decode every `SUPABASE_*` override goes through
    // (`config.go:749-756`) — a malformed `SUPABASE_ANALYTICS_BACKEND` fails
    // config loading outright, same mechanism as the port/bool overrides below.
    it("rejects an invalid SUPABASE_ANALYTICS_BACKEND override", () => {
      process.env["SUPABASE_ANALYTICS_BACKEND"] = "mysql";
      const config = baseConfig({ analytics: { enabled: true, backend: "postgres" } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        LegacyInvalidAnalyticsBackendEnvOverrideError,
      );
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        'Invalid config for analytics.backend: cannot parse "mysql" as one of "postgres", "bigquery"',
      );
    });
  });

  describe("experimental.* (experimental.validate())", () => {
    // Go's `(e *experimental) validate()` (`pkg/config/config.go:1846-1854`),
    // called right after the analytics/bigquery block and right before
    // `Config.Validate` returns — unconditionally, no `enabled` gate of its own.
    //
    // Every webhooks-presence/enabled combination and the pgdelta format_options JSON checks
    // moved to `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig`
    // calls, setting `experimental.webhooksPresent`/`webhooksEnabled` directly instead of
    // deriving them from a raw `document`) — only this document-THREADING-specific case stays
    // here, since it exercises this function's own "no document provided" fallback rather than
    // a check `legacyValidateResolvedConfig` itself owns.
    it("does not throw a present [experimental.webhooks] section without enabled when no document is provided", () => {
      // No `document` (5th param) at all — e.g. a caller that hasn't threaded
      // `LoadedProjectConfig.document` through yet. The presence-only check
      // can't run without it, so it's skipped rather than guessed at; this
      // also covers every pre-existing call site/test in this file that
      // doesn't pass a 5th argument.
      const config = baseConfig({ experimental: { webhooks: {} } });
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
    // The pure empty/set/disabled assertions moved to `legacy-config-validate.unit.test.ts`
    // (direct `legacyValidateResolvedConfig` calls) — only the SUPABASE_AUTH_ENABLED /
    // SUPABASE_AUTH_SITE_URL env-override mechanics stay here.
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

  // auth.captcha/passkey/webauthn/hook/smtp REQUIRED-FIELD checks (the actual `enabled` ⇒
  // provider/secret/uri/host/etc. logic) live entirely in `legacy-config-validate.unit.test.ts`
  // (direct `legacyValidateResolvedConfig` calls). Only the SUPABASE_*-env-override MECHANICS
  // this resolver owns — layering an env/dotenv value on top of the TOML-decoded or
  // raw-document-derived value before that validation ever runs — are tested here, same split as
  // `auth.site_url` above.

  describe("auth.captcha env overrides", () => {
    // `auth.captcha.*` is Viper-bound like any other nested field once `[auth.captcha]` is
    // present in config.toml (`ExperimentalBindStruct`/`AutomaticEnv`, `config.go:581-586`).
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
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.captcha.provider");
    });

    it("does not throw when an incomplete enabled captcha section is disabled only via env", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = "false";
      const config = baseConfig({ auth: { captcha: { enabled: true } } });
      const document = { auth: { captcha: { enabled: true } } };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("accepts env-provided provider/secret overriding an enabled captcha section", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"] = "hcaptcha";
      process.env["SUPABASE_AUTH_CAPTCHA_SECRET"] = "shh";
      const config = baseConfig({ auth: { captcha: { enabled: true } } });
      const document = { auth: { captcha: { enabled: true } } };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not synthesize a captcha section purely from an env override when [auth.captcha] is absent", () => {
      process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.passkey / auth.webauthn env overrides", () => {
    // `auth.passkey.enabled`/`auth.webauthn.*` are Viper-bound like any other nested field once
    // `[auth.passkey]`/`[auth.webauthn]` are present in config.toml. Both are read from the raw
    // `document` (5th param), same as the presence-based defaulting above, so these tests thread
    // a `document` object through explicitly instead of relying on `baseConfig`'s decoded schema
    // (which has no `passkey`/`webauthn` fields at all).
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
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
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
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not synthesize a passkey section purely from an env override when [auth.passkey] is absent from the document", () => {
      process.env["SUPABASE_AUTH_PASSKEY_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.hook.* env overrides", () => {
    // `auth.hook.<type>.*` is Viper-bound like any other nested field once `[auth.hook.<type>]`
    // is present in config.toml. `@supabase/config`'s hook schema always decodes a default
    // `{ enabled: false }` regardless of file presence, so — like passkey/webauthn above — the
    // presence gate is read from the raw `document`, not the decoded `config`.
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
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.hook.send_email.uri");
    });

    it("accepts an env-provided uri overriding a TOML-enabled hook missing its uri", () => {
      process.env["SUPABASE_AUTH_HOOK_SEND_EMAIL_URI"] = "pg-functions://postgres/auth/hook";
      const config = baseConfig({ auth: { hook: { send_email: { enabled: true } } } });
      const document = { auth: { hook: { send_email: { enabled: true } } } };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not synthesize a hook enablement purely from an env override when the section is absent from the document", () => {
      process.env["SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.email.smtp env overrides", () => {
    // `auth.email.smtp.*` is Viper-bound like any other nested field once `[auth.email.smtp]`
    // is present in config.toml — layered on top of the presence-aware raw-document read that
    // already exists here for Go's presence-based `enabled` default.
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
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
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
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
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
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow(LegacyInvalidPortEnvOverrideError);
    });

    it("does not synthesize an smtp section purely from an env override when [auth.email.smtp] is absent from the document", () => {
      process.env["SUPABASE_AUTH_EMAIL_SMTP_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.mfa env overrides", () => {
    // `auth.mfa.<factor>.*` is Viper-bound unconditionally (value-typed struct fields, never
    // `nil`) — unlike hooks/smtp above, no raw-document presence gate is needed; see the block
    // comment above the `mfa` array in legacy-local-config-values.ts.
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"];
      delete process.env["SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED"];
    });

    it("rejects an env-enabled enroll factor left at its TOML-decoded verify default", () => {
      process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid MFA config: auth.mfa.totp.enroll_enabled requires verify_enabled",
      );
    });

    it("accepts an env-enabled enroll factor when verify is also env-enabled", () => {
      process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"] = "true";
      process.env["SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects a malformed SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED override", () => {
      process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"] = "not-a-bool";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        LegacyInvalidBoolEnvOverrideError,
      );
    });
  });

  describe("auth.third_party env overrides", () => {
    // Same value-typed-struct reasoning as auth.mfa above — including `workos`, whose default
    // template omits `[auth.third_party.workos]` entirely yet is still unconditionally overridable.
    afterEach(() => {
      delete process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED"];
      delete process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID"];
    });

    it("rejects a third-party provider enabled only via env with no required field configured", () => {
      process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
      );
    });

    it("accepts an env-provided project_id overriding a TOML-enabled firebase provider", () => {
      process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID"] = "my-project";
      const config = baseConfig({ auth: { third_party: { firebase: { enabled: true } } } });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("does not enable a third-party provider purely from a required-field env override", () => {
      process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID"] = "my-project";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.email.template/notification (content_path validation)", () => {
    // Go's `(e *email) validate(fsys)` (`pkg/config/config.go:1293-1313`),
    // called right after `Auth.MFA.validate()`, still inside `if c.Auth.Enabled`.
    const tempRoot = useLegacyTempWorkdir("supabase-email-templates-test-");

    it("rejects a template content_path pointing at a missing file", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: { content_path: "missing-invite.html" } } },
        },
      });
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "Invalid config for auth.email.template.invite.content_path: ",
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
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });

    it("does not throw a template with no content_path configured", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: {} } },
        },
      });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
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
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "Invalid config for auth.email.notification.password_changed.content_path: ",
      );
    });

    it("resolves a relative notification content_path against <workdir>/supabase", () => {
      const supabaseDir = join(tempRoot.current, "supabase");
      mkdirSync(supabaseDir, { recursive: true });
      writeFileSync(join(supabaseDir, "pw-changed.html"), "<html></html>");
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
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
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
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });

    it("does not throw a missing template content_path when auth is disabled", () => {
      const config = baseConfig({
        auth: { enabled: false, email: { template: { invite: { content_path: "missing.html" } } } },
      });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });

    // Divergence #2 (see `legacy-config-validate.ts`'s port-plan notes): Go's asymmetric
    // content-vs-content_path exclusivity (`config.go:1293-1313`) — a raw `content` key present
    // with no `content_path` is an error, not a silent no-op. `@supabase/config`'s schema has no
    // `content` field to see, so this only fires when the raw `document` (5th param) carries it.
    it("rejects a template content key present without content_path", () => {
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { template: { invite: {} } },
        },
      });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current, undefined, {
          auth: { email: { template: { invite: { content: "<html>Hi</html>" } } } },
        }),
      ).toThrow(
        "Invalid config for auth.email.template.invite.content: please use content_path instead",
      );
    });
  });

  describe("auth.email.template/notification env overrides", () => {
    // `auth.email.template.<name>.*`/`auth.email.notification.<name>.*` are Viper-bound like any
    // other nested field once the section is present in config.toml. Unlike hook/passkey, no
    // extra raw-document presence gate is needed: `email.template`/`email.notification` are
    // `Schema.Record`s, so `Object.entries` on the decoded config already reflects presence.
    const tempRoot = useLegacyTempWorkdir("supabase-email-template-env-test-");

    afterEach(() => {
      delete process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH"];
      delete process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED"];
      delete process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT_PATH"];
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
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });

    it("rejects a notification enabled only via env with a missing content_path file", () => {
      // Go applies SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED before
      // Auth.Email.validate() decides whether to read content_path — a notification disabled
      // in TOML but enabled by env must still be checked.
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
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
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
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });

    it("lets an env-provided notification content_path override a missing TOML content_path", () => {
      const supabaseDir = join(tempRoot.current, "supabase");
      mkdirSync(supabaseDir, { recursive: true });
      writeFileSync(join(supabaseDir, "pw-changed.html"), "<html></html>");
      process.env["SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT_PATH"] =
        "pw-changed.html";
      const config = baseConfig({
        auth: {
          enabled: true,
          site_url: "http://localhost:3000",
          email: { notification: { password_changed: { enabled: true } } },
        },
      });
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
      ).not.toThrow();
    });
  });

  // auth.third_party.* (thirdParty.validate()) and functions.* (function-slug validation)
  // moved entirely to `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig`
  // calls) — L pre-filters to enabled-only third_party providers and derives function slugs
  // directly off `config.functions` with no env-override mechanics of its own for these checks.

  describe("auth.external (external.validate(), D-only, ported to L)", () => {
    // `auth.external` is a genuine Go `map[string]provider`, so an unmodeled/arbitrary provider
    // name is a legitimate config shape `@supabase/config`'s schema silently drops at decode —
    // this check reads the raw `document` (5th param) instead, same as passkey/hook above.
    it("rejects an enabled unmodeled external provider missing client_id", () => {
      const config = baseConfig();
      const document = { auth: { external: { custom: { enabled: true } } } };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.external.custom.client_id");
    });

    it("rejects an enabled unmodeled external provider missing secret", () => {
      const config = baseConfig();
      const document = {
        auth: { external: { custom: { enabled: true, client_id: "abc" } } },
      };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.external.custom.secret");
    });

    it("does not require a secret for apple/google providers", () => {
      const config = baseConfig();
      const document = {
        auth: { external: { apple: { enabled: true, client_id: "abc" } } },
      };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("skips deprecated linkedin/slack providers", () => {
      const config = baseConfig();
      const document = { auth: { external: { slack: { enabled: true } } } };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not validate a disabled unmodeled external provider", () => {
      const config = baseConfig();
      const document = { auth: { external: { custom: { enabled: false } } } };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("skips the check entirely when no document is threaded through", () => {
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.external env overrides", () => {
    // `auth.external.<name>.*` is Viper-bound like any other nested field once
    // `[auth.external.<name>]` is present in config.toml — same gap the schema's own
    // `requiredWhenEnabled` check has for KNOWN providers too.
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
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.external.custom.client_id");
    });

    it("accepts env-provided client_id/secret overriding a TOML-enabled provider missing both", () => {
      process.env["SUPABASE_AUTH_EXTERNAL_CUSTOM_CLIENT_ID"] = "abc";
      process.env["SUPABASE_AUTH_EXTERNAL_CUSTOM_SECRET"] = "shh";
      const config = baseConfig();
      const document = { auth: { external: { custom: { enabled: true } } } };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not synthesize a provider purely from an env override when the section is absent from the document", () => {
      process.env["SUPABASE_AUTH_EXTERNAL_CUSTOM_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.sms env overrides (provider switch)", () => {
    // Go's `(s *sms) validate()` (`pkg/config/config.go:1348-1410`) is a `switch` that validates
    // ONLY the first enabled provider in a fixed priority order (twilio, twilio_verify,
    // messagebird, textlocal, vonage). `@supabase/config`'s schema already implements this switch
    // for the schema-decoded (pre-env-override) TOML value; this re-runs it against the raw
    // document with `SUPABASE_AUTH_SMS_*` overrides applied, since the schema never sees them.
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
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.sms.twilio.account_sid");
    });

    it("accepts env-provided credentials overriding a TOML-enabled provider missing them", () => {
      process.env["SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID"] = "AC123";
      process.env["SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID"] = "MG123";
      process.env["SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN"] = "tok";
      const config = baseConfig();
      const document = { auth: { sms: { twilio: { enabled: true } } } };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("only validates the first enabled provider in Go's fixed priority order", () => {
      // twilio is disabled via env; messagebird becomes the switch winner and is missing its
      // required fields — twilio's own (still-missing) fields must never be inspected.
      process.env["SUPABASE_AUTH_SMS_TWILIO_ENABLED"] = "false";
      process.env["SUPABASE_AUTH_SMS_MESSAGEBIRD_ENABLED"] = "true";
      const config = baseConfig();
      const document = {
        auth: { sms: { twilio: { enabled: true }, messagebird: { enabled: false } } },
      };
      expect(() =>
        legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.sms.messagebird.originator");
    });

    it("does not synthesize a provider purely from an env override when the section is absent from the document", () => {
      process.env["SUPABASE_AUTH_SMS_TWILIO_ENABLED"] = "true";
      const config = baseConfig();
      expect(() => legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
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

    // The "exactly one of cert/key set" presence-only assertions moved to
    // `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig` calls) —
    // the actual file reads below stay here, since I/O is per-caller.

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
