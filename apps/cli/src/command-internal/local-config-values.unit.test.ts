import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { CliConfigValueError } from "../config/cli-config.errors.ts";
import { DEFAULT_SIGNING_KEY } from "./go-jwt.ts";
import {
  POSTGRES_DEFAULT_ROOT_KEY,
  InvalidJwtSecretError,
  narrowConfigEnum,
  rawUnmodeledBool,
  resolveAuthCaptcha,
  resolveAuthEmail,
  resolveAuthExternalProviders,
  resolveAuthHooks,
  resolveAuthSms,
  resolveDbSettingsEnvOverrides,
  resolveLocalConfigValues,
  resolveLocalJwks,
} from "./local-config-values.ts";

const runLocalJwks = (...args: Parameters<typeof resolveLocalJwks>) =>
  Effect.runPromise(
    resolveLocalJwks(...args).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    ),
  );

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

  it("rejects an explicit empty project_id", () => {
    // An explicit `project_id = ""` overwrites the workdir-basename default with the literal
    // empty string, unlike an absent key.
    const config = baseConfig({ project_id: "" });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "Missing required field in config: project_id",
    );
  });

  it("hardcodes the local S3 credentials", () => {
    const config = baseConfig();
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.storageS3AccessKeyId).toBe("625729a08b95bf1b7ff351a663f3a23c");
    expect(values.storageS3SecretAccessKey).toBe(
      "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
    );
    expect(values.storageS3Region).toBe("local");
  });

  describe("non-auth port validation", () => {
    // Unlike the malformed/out-of-range cases above, db.port=0 is a required-field failure with
    // no `enabled` gate, unlike api.port/studio.port/local_smtp.port.
    // api.enabled defaults to true, so this rejection applies without an explicit
    // `api.enabled = true`.
    it("rejects a configured api.port of 0 when api is enabled", () => {
      const config = baseConfig({ api: { port: 0 } });
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

    // local_smtp.enabled defaults to true, so this rejection applies without an explicit
    // `local_smtp.enabled = true`.
    it("rejects a configured local_smtp.port of 0 when local_smtp is enabled", () => {
      const config = baseConfig({ local_smtp: { port: 0 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: local_smtp.port",
      );
    });

    it("does not reject a zero local_smtp.port when local_smtp is disabled", () => {
      const config = baseConfig({ local_smtp: { enabled: false, port: 0 } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
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
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document);
      expect(values.rootKey).toBe("custom-root-key");
    });

    it("rejects a non-string root_key (e.g. a bare TOML integer)", () => {
      const config = baseConfig();
      const document = { db: { root_key: 12345 } };
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)).toThrow(
        "failed to parse config: decoding failed due to the following error(s):\n\n'db.root_key' expected a map or struct",
      );
    });
  });

  // storage.buckets validation lives entirely in config-validate.unit.test.ts; this file has no
  // bucket-related mechanics of its own.

  describe("experimental.* (experimental.validate())", () => {
    // Exercises this function's own fallback when no `document` (5th param) is supplied; the
    // required-field/enabled checks themselves live in config-validate.unit.test.ts.
    it("does not throw a present [experimental.webhooks] section without enabled when no document is provided", () => {
      const config = baseConfig({ experimental: { webhooks: {} } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("resolveAuthCaptcha", () => {
    it("returns undefined when captcha is not configured", () => {
      expect(resolveAuthCaptcha(undefined)).toBeUndefined();
    });
  });

  describe("resolveAuthEmail", () => {
    it("keeps an explicit empty subject present in the raw document, not omitted", () => {
      const config = baseConfig({
        auth: { email: { template: { confirmation: { subject: "", content_path: "x" } } } },
      });
      const authDocument = { email: { template: { confirmation: { subject: "" } } } };
      const resolved = resolveAuthEmail(config.auth.email, authDocument);
      expect(resolved.template["confirmation"]?.subject).toBe("");
    });

    it("omits the subject when the key is absent from the raw document", () => {
      const config = baseConfig({
        auth: { email: { template: { confirmation: { content_path: "x" } } } },
      });
      const authDocument = { email: { template: { confirmation: { content_path: "x" } } } };
      const resolved = resolveAuthEmail(config.auth.email, authDocument);
      expect(resolved.template["confirmation"]?.subject).toBeUndefined();
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

    it("leaves every hook disabled when nothing is configured or overridden", () => {
      const resolved = resolveAuthHooks(allHooks);
      expect(resolved.customAccessToken.enabled).toBe(false);
      expect(resolved.mfaVerificationAttempt.enabled).toBe(false);
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
      const resolved = resolveAuthExternalProviders(authDocument, baseConfig().auth.external);
      expect(resolved["my_custom"]?.enabled).toBe(true);
      expect(resolved["my_custom"]?.skipNonceCheck).toBe(false);
      expect(resolved["my_custom"]?.emailOptional).toBe(true);
    });

    it("throws on an unparsable custom-provider boolean string instead of silently disabling it", () => {
      const authDocument = {
        external: { my_custom: { enabled: "not-a-bool", client_id: "custom-client-id" } },
      };
      expect(() => resolveAuthExternalProviders(authDocument, baseConfig().auth.external)).toThrow(
        'cannot parse "not-a-bool" as a bool',
      );
    });

    it("leaves an absent custom-provider boolean field at its schema default without throwing", () => {
      const authDocument = {
        external: { my_custom: { client_id: "custom-client-id" } },
      };
      const resolved = resolveAuthExternalProviders(authDocument, baseConfig().auth.external);
      expect(resolved["my_custom"]?.enabled).toBe(false);
    });

    it("weakly coerces a raw numeric custom-provider boolean by truthiness", () => {
      const authDocument = {
        external: { my_custom: { enabled: 1, client_id: "custom-client-id" } },
      };
      const resolved = resolveAuthExternalProviders(authDocument, baseConfig().auth.external);
      expect(resolved["my_custom"]?.enabled).toBe(true);
    });

    it("throws on a raw array/table custom-provider boolean instead of silently disabling it", () => {
      const authDocument = {
        external: { my_custom: { enabled: [1, 2], client_id: "custom-client-id" } },
      };
      expect(() => resolveAuthExternalProviders(authDocument, baseConfig().auth.external)).toThrow(
        'cannot parse "1,2" as a bool',
      );
    });
  });

  describe("rawUnmodeledBool", () => {
    it("returns false for an absent value", () => {
      expect(rawUnmodeledBool(undefined, "auth.passkey.enabled")).toBe(false);
    });

    it("passes a real boolean through unchanged", () => {
      expect(rawUnmodeledBool(true, "auth.passkey.enabled")).toBe(true);
      expect(rawUnmodeledBool(false, "auth.passkey.enabled")).toBe(false);
    });

    it("coerces a raw number by truthiness", () => {
      expect(rawUnmodeledBool(123, "auth.passkey.enabled")).toBe(true);
      expect(rawUnmodeledBool(0, "auth.passkey.enabled")).toBe(false);
      expect(rawUnmodeledBool(1.5, "auth.passkey.enabled")).toBe(true);
    });

    it("parses boolean-ish strings", () => {
      expect(rawUnmodeledBool("true", "auth.passkey.enabled")).toBe(true);
      expect(rawUnmodeledBool("False", "auth.passkey.enabled")).toBe(false);
      expect(rawUnmodeledBool("", "auth.passkey.enabled")).toBe(false);
    });

    it("throws on an unparsable string instead of silently disabling it", () => {
      expect(() => rawUnmodeledBool("not-a-bool", "auth.passkey.enabled")).toThrow(
        'cannot parse "not-a-bool" as a bool',
      );
    });

    it("throws on an array or table value instead of coercing it", () => {
      expect(() => rawUnmodeledBool([1, 2], "auth.passkey.enabled")).toThrow(CliConfigValueError);
      expect(() => rawUnmodeledBool({ nested: true }, "auth.passkey.enabled")).toThrow(
        CliConfigValueError,
      );
    });
  });

  describe("resolveDbSettingsEnvOverrides", () => {
    it("returns the configured settings unchanged when nothing is overridden", () => {
      const settings = { shared_buffers: "128MB", max_connections: 100 };
      expect(resolveDbSettingsEnvOverrides(settings)).toEqual(settings);
    });

    it("leaves an unconfigured field undefined when nothing is overridden", () => {
      expect(resolveDbSettingsEnvOverrides({}).effective_cache_size).toBeUndefined();
    });

    it("leaves session_replication_role undefined when neither configured nor overridden", () => {
      expect(resolveDbSettingsEnvOverrides({}).session_replication_role).toBeUndefined();
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

    it("throws an error when the signing keys file does not exist", () => {
      const config = baseConfig({ auth: { signing_keys_path: "missing.json" } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to read signing keys: ",
      );
    });

    it("throws an error when the signing keys file is malformed JSON", () => {
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
  });

  // Required-field/range assertions live in config-validate.unit.test.ts; only env-override
  // mechanics are tested here.

  describe("auth.passkey / auth.webauthn env overrides", () => {
    // `auth.passkey`/`auth.webauthn` have no decoded-schema presence signal, so these tests thread
    // a raw `document` object through explicitly instead of relying on `baseConfig`.

    it("throws on an unparsable raw auth.passkey.enabled string instead of silently disabling it", () => {
      const config = baseConfig();
      const document = { auth: { passkey: { enabled: "not-a-bool" } } };
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)).toThrow(
        'cannot parse "not-a-bool" as a bool',
      );
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
        resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current, {
          auth: { email: { template: { invite: { content: "<html>Hi</html>" } } } },
        }),
      ).toThrow(
        "Invalid config for auth.email.template.invite.content: please use content_path instead",
      );
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
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)).toThrow(
        "Missing required field in config: auth.external.custom.client_id",
      );
    });

    it("rejects an enabled unmodeled external provider missing secret", () => {
      const config = baseConfig();
      const document = {
        auth: { external: { custom: { enabled: true, client_id: "abc" } } },
      };
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)).toThrow(
        "Missing required field in config: auth.external.custom.secret",
      );
    });

    it("does not require a secret for apple/google providers", () => {
      const config = baseConfig();
      const document = {
        auth: { external: { apple: { enabled: true, client_id: "abc" } } },
      };
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)).not.toThrow();
    });

    it("skips deprecated linkedin/slack providers", () => {
      const config = baseConfig();
      const document = { auth: { external: { slack: { enabled: true } } } };
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)).not.toThrow();
    });

    it("does not validate a disabled unmodeled external provider", () => {
      const config = baseConfig();
      const document = { auth: { external: { custom: { enabled: false } } } };
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)).not.toThrow();
    });

    it("skips the check entirely when no document is threaded through", () => {
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("resolveAuthSms (top-level scalars)", () => {
    it("leaves the scalars at their configured values when nothing is overridden", () => {
      const configured = {
        ...baseConfig().auth.sms,
        enable_signup: true,
        max_frequency: "5s",
        twilio: { ...baseConfig().auth.sms.twilio, enabled: true },
      };
      const resolved = resolveAuthSms(configured);
      expect(resolved.enable_signup).toBe(true);
      expect(resolved.max_frequency).toBe("5s");
    });
  });

  describe("resolveAuthSms (disables phone login with no provider enabled)", () => {
    it("downgrades enable_signup to false when configured true with no provider enabled", () => {
      const configured = { ...baseConfig().auth.sms, enable_signup: true };
      const resolved = resolveAuthSms(configured);
      expect(resolved.enable_signup).toBe(false);
    });

    it("leaves enable_signup alone when a provider is enabled", () => {
      const configured = {
        ...baseConfig().auth.sms,
        enable_signup: true,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true },
      };
      const resolved = resolveAuthSms(configured);
      expect(resolved.enable_signup).toBe(true);
    });

    it("leaves enable_signup at false when already false with no provider enabled", () => {
      const resolved = resolveAuthSms(baseConfig().auth.sms);
      expect(resolved.enable_signup).toBe(false);
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

    it("throws an error when the configured cert file does not exist", () => {
      writeTlsFile(tempRoot.current, "key.pem");
      const config = baseConfig({
        api: { tls: { enabled: true, cert_path: "missing-cert.pem", key_path: "key.pem" } },
      });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
        "failed to read TLS cert: ",
      );
    });

    it("throws an error when the configured key file does not exist", () => {
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
  });
});

describe("narrowConfigEnum", () => {
  it("returns a configured value that is one of the allowed values", () => {
    expect(narrowConfigEnum("realtime.ip_version", "IPv6", ["IPv4", "IPv6"])).toBe("IPv6");
  });

  it("fails with the config value error naming every allowed value", () => {
    expect(() => narrowConfigEnum("realtime.ip_version", "v9", ["IPv4", "IPv6"])).toThrow(
      new CliConfigValueError({
        path: "realtime.ip_version",
        tier: "config",
        message:
          'Invalid config for realtime.ip_version: cannot parse "v9" as one of "IPv4", "IPv6"',
      }),
    );
  });
});

describe("resolveLocalJwks", () => {
  const tempRoot = useTempWorkdir("supabase-local-jwks-test-");

  it("includes the default ES256 signing key and the oct JWT-secret fallback when no signing_keys_path is configured", async () => {
    const config = baseConfig();
    const jwks = await runLocalJwks(config, tempRoot.current, "a".repeat(32));
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
    const jwks = await runLocalJwks(config, tempRoot.current, "a".repeat(32));
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
    const jwks = await runLocalJwks(config, tempRoot.current, "a".repeat(32));
    const parsed = JSON.parse(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };

    expect(parsed.keys[0]).toMatchObject({ use: "sig", ext: true, key_ops: ["verify"] });
  });

  it("falls back to the default ES256 signing key (not the configured file, not the oct fallback) when auth is disabled but signing_keys_path is set", async () => {
    writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
    const config = baseConfig({
      auth: { enabled: false, signing_keys_path: "signing_keys.json" },
    });
    const jwks = await runLocalJwks(config, tempRoot.current, "a".repeat(32));
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

  it("throws an error when the signing keys file does not exist", async () => {
    const config = baseConfig({ auth: { signing_keys_path: "missing.json" } });
    await expect(runLocalJwks(config, tempRoot.current, "a".repeat(32))).rejects.toThrow(
      "failed to read signing keys: ",
    );
  });

  it("throws an error when the signing keys file is malformed JSON", async () => {
    const supabaseDir = join(tempRoot.current, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    writeFileSync(join(supabaseDir, "signing_keys.json"), "not valid json");
    const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
    await expect(runLocalJwks(config, tempRoot.current, "a".repeat(32))).rejects.toThrow(
      "failed to decode signing keys: ",
    );
  });

  describe("auth.third_party", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("rejects an enabled third-party provider missing its required field", async () => {
      const config = baseConfig({ auth: { third_party: { firebase: { enabled: true } } } });
      await expect(runLocalJwks(config, WORKDIR, "a".repeat(32))).rejects.toThrow(
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
      await expect(runLocalJwks(config, WORKDIR, "a".repeat(32))).rejects.toThrow(
        "Invalid config: Only one third_party provider allowed to be enabled at a time.",
      );
    });

    it("does not validate third-party providers when auth is disabled", async () => {
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
      const jwksJson = await runLocalJwks(config, WORKDIR, "a".repeat(32));
      const jwks = JSON.parse(jwksJson) as { keys: ReadonlyArray<{ kid?: string }> };
      expect(jwks.keys.some((key) => key.kid === "firebase-key")).toBe(true);
      fetchMock.mockRestore();
    });

    it("does not attempt a remote JWKS fetch for an enabled third-party provider with an empty issuer_url", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const config = baseConfig({
        auth: {
          enabled: false,
          third_party: { workos: { enabled: true, issuer_url: "" } },
        },
      });

      const jwksJson = await runLocalJwks(config, WORKDIR, "a".repeat(32));
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
      const jwks = await runLocalJwks(config, WORKDIR, "a".repeat(32));
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
      await expect(runLocalJwks(config, WORKDIR, "a".repeat(32))).rejects.toThrow(
        "Failed to fetch https://issuer.example/.well-known/openid-configuration",
      );
    });
  });
});
