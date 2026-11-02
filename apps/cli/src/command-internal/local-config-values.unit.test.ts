import { generateKeyPairSync } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { importJWK, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { useTempWorkdir } from "../../tests/helpers/command-mocks.ts";
import { CliConfigValueError } from "../config/cli-config.errors.ts";
import { DEFAULT_SIGNING_KEY } from "./local-jwt.ts";
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

const join = (...segments: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(...segments);
  });

const mkdirp = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(directory, { recursive: true });
  });

const writeFile = (file: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(file, contents);
  });

const runLocalJwks = (...args: Parameters<typeof resolveLocalJwks>) =>
  resolveLocalJwks(...args).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
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

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const writeSigningKeys = (workdir: string, jwks: ReadonlyArray<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const supabaseDir = yield* join(workdir, "supabase");
    yield* mkdirp(supabaseDir);
    yield* writeFile(yield* join(supabaseDir, "signing_keys.json"), yield* encodeJson(jwks));
  });

describe("resolveLocalConfigValues", () => {
  it.live("derives every URL from api.external_url when unset", () =>
    Effect.gen(function* () {
      const config = baseConfig();
      const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);

      expect(values.apiUrl).toBe("http://127.0.0.1:54321");
      expect(values.restUrl).toBe("http://127.0.0.1:54321/rest/v1");
      expect(values.graphqlUrl).toBe("http://127.0.0.1:54321/graphql/v1");
      expect(values.functionsUrl).toBe("http://127.0.0.1:54321/functions/v1");
      expect(values.mcpUrl).toBe("http://127.0.0.1:54321/mcp");
      expect(values.storageS3Url).toBe("http://127.0.0.1:54321/storage/v1/s3");
      expect(values.studioUrl).toBe("http://127.0.0.1:54323");
      expect(values.mailpitUrl).toBe("http://127.0.0.1:54324");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("uses https and the configured port when api.tls.enabled", () =>
    Effect.gen(function* () {
      const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
      const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("https://127.0.0.1:54321");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("uses api.external_url verbatim when configured", () =>
    Effect.gen(function* () {
      const config = baseConfig({ api: { external_url: "https://example.test" } });
      const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.apiUrl).toBe("https://example.test");
      expect(values.restUrl).toBe("https://example.test/rest/v1");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("brackets an IPv6 hostname when building host:port", () =>
    Effect.gen(function* () {
      const config = baseConfig();
      const values = yield* resolveLocalConfigValues(config, "::1", WORKDIR);
      expect(values.apiUrl).toBe("http://[::1]:54321");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("builds the db URL with the hardcoded postgres password", () =>
    Effect.gen(function* () {
      const config = baseConfig({ db: { port: 54322 } });
      const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("falls back to the default JWT secret and opaque keys when unset", () =>
    Effect.gen(function* () {
      const config = baseConfig();
      const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.jwtSecret).toBe("super-secret-jwt-token-with-at-least-32-characters-long");
      expect(values.publishableKey).toBe("sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH");
      expect(values.secretKey).toBe("sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("uses configured opaque keys verbatim when set", () =>
    Effect.gen(function* () {
      const config = baseConfig({
        auth: { publishable_key: "sb_publishable_custom", secret_key: "sb_secret_custom" },
      });
      const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.publishableKey).toBe("sb_publishable_custom");
      expect(values.secretKey).toBe("sb_secret_custom");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("signs the default anon/service_role JWTs from the resolved secret", () =>
    Effect.gen(function* () {
      const config = baseConfig();
      const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      const [, anonPayload] = values.anonKey.split(".");
      const [, serviceRolePayload] = values.serviceRoleKey.split(".");
      expect(
        yield* decodeJson(Buffer.from(anonPayload ?? "", "base64url").toString()),
      ).toMatchObject({
        role: "anon",
      });
      expect(
        yield* decodeJson(Buffer.from(serviceRolePayload ?? "", "base64url").toString()),
      ).toMatchObject({ role: "service_role" });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("uses configured anon/service_role keys verbatim when set", () =>
    Effect.gen(function* () {
      const config = baseConfig({
        auth: { anon_key: "configured-anon", service_role_key: "configured-service-role" },
      });
      const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.anonKey).toBe("configured-anon");
      expect(values.serviceRoleKey).toBe("configured-service-role");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("signs anon/service_role JWTs from a configured jwt_secret", () =>
    Effect.gen(function* () {
      const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
      const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.jwtSecret).toBe("a".repeat(32));
      expect(values.anonKey).not.toBe("");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects a configured jwt_secret shorter than 16 characters", () =>
    Effect.gen(function* () {
      const config = baseConfig({ auth: { jwt_secret: "a".repeat(15) } });
      expect(
        yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)),
      ).toBeInstanceOf(InvalidJwtSecretError);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects an explicit empty project_id", () =>
    Effect.gen(function* () {
      // An explicit `project_id = ""` overwrites the workdir-basename default with the literal
      // empty string, unlike an absent key.
      const config = baseConfig({ project_id: "" });
      expect(
        (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", WORKDIR))).message,
      ).toContain("Missing required field in config: project_id");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("hardcodes the local S3 credentials", () =>
    Effect.gen(function* () {
      const config = baseConfig();
      const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.storageS3AccessKeyId).toBe("625729a08b95bf1b7ff351a663f3a23c");
      expect(values.storageS3SecretAccessKey).toBe(
        "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907",
      );
      expect(values.storageS3Region).toBe("local");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  describe("non-auth port validation", () => {
    // Unlike the malformed/out-of-range cases above, db.port=0 is a required-field failure with
    // no `enabled` gate, unlike api.port/studio.port/local_smtp.port.
    // api.enabled defaults to true, so this rejection applies without an explicit
    // `api.enabled = true`.
    it.live("rejects a configured api.port of 0 when api is enabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({ api: { port: 0 } });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", WORKDIR))).message,
        ).toContain("Missing required field in config: api.port");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not reject a zero api.port when api is disabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({ api: { enabled: false, port: 0 } });
        expect(yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    // studio.enabled defaults to true, so this rejection applies without an explicit
    // `studio.enabled = true`.
    it.live("rejects a configured studio.port of 0 when studio is enabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({ studio: { port: 0 } });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", WORKDIR))).message,
        ).toContain("Missing required field in config: studio.port");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not reject a zero studio.port when studio is disabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({ studio: { enabled: false, port: 0 } });
        expect(yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "rejects a malformed studio.api_url (unterminated IPv6 literal) when studio is enabled",
      () =>
        Effect.gen(function* () {
          const config = baseConfig({ studio: { api_url: "http://[::1" } });
          expect(
            (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", WORKDIR))).message,
          ).toContain(
            `Invalid config for studio.api_url: parse "http://[::1": missing ']' in host`,
          );
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not reject a malformed studio.api_url when studio is disabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({ studio: { enabled: false, api_url: "http://[::1" } });
        expect(yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not throw for the default studio.api_url", () =>
      Effect.gen(function* () {
        const config = baseConfig();
        expect(yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    // local_smtp.enabled defaults to true, so this rejection applies without an explicit
    // `local_smtp.enabled = true`.
    it.live("rejects a configured local_smtp.port of 0 when local_smtp is enabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({ local_smtp: { port: 0 } });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", WORKDIR))).message,
        ).toContain("Missing required field in config: local_smtp.port");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not reject a zero local_smtp.port when local_smtp is disabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({ local_smtp: { enabled: false, port: 0 } });
        expect(yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("db.root_key (unmodeled raw-document field)", () => {
    it.live("falls back to the default root key when absent", () =>
      Effect.gen(function* () {
        const config = baseConfig();
        const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.rootKey).toBe(POSTGRES_DEFAULT_ROOT_KEY);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("uses a configured string root_key verbatim", () =>
      Effect.gen(function* () {
        const config = baseConfig();
        const document = { db: { root_key: "custom-root-key" } };
        const values = yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document);
        expect(values.rootKey).toBe("custom-root-key");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects a non-string root_key (e.g. a bare TOML integer)", () =>
      Effect.gen(function* () {
        const config = baseConfig();
        const document = { db: { root_key: 12345 } };
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)))
            .message,
        ).toContain("failed to parse config:\ndb.root_key: expected a table");
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  // storage.buckets validation lives entirely in config-validate.unit.test.ts; this file has no
  // bucket-related mechanics of its own.

  describe("experimental.* (experimental.validate())", () => {
    // Exercises this function's own fallback when no `document` (5th param) is supplied; the
    // required-field/enabled checks themselves live in config-validate.unit.test.ts.
    it.live(
      "does not throw a present [experimental.webhooks] section without enabled when no document is provided",
      () =>
        Effect.gen(function* () {
          const config = baseConfig({ experimental: { webhooks: {} } });
          expect(yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toBeDefined();
        }).pipe(Effect.provide(BunServices.layer)),
    );
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
        '"not-a-bool" is not a valid boolean',
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
        '"1,2" is not a valid boolean',
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
        '"not-a-bool" is not a valid boolean',
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

    it.live("signs anon/service_role with the first RS256 key in the file", () =>
      Effect.gen(function* () {
        const jwk = generateRsaJwk();
        yield* writeSigningKeys(tempRoot.current, [jwk]);
        const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
        const values = yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);

        const publicJwk = { ...jwk, d: undefined, p: undefined, q: undefined, dp: undefined };
        const publicKey = yield* Effect.promise(() => importJWK(publicJwk, "RS256"));
        const { payload, protectedHeader } = yield* Effect.promise(() =>
          jwtVerify(values.anonKey, publicKey),
        );
        expect(payload).toMatchObject({ iss: "supabase-demo", role: "anon" });
        expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "test-rsa-kid" });

        const serviceRole = yield* Effect.promise(() =>
          jwtVerify(values.serviceRoleKey, publicKey),
        );
        expect(serviceRole.payload).toMatchObject({ role: "service_role" });
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("resolves a relative signing_keys_path against <workdir>/supabase", () =>
      Effect.gen(function* () {
        const jwk = generateRsaJwk();
        yield* writeSigningKeys(tempRoot.current, [jwk]);
        const config = baseConfig({ auth: { signing_keys_path: "./signing_keys.json" } });
        const values = yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
        expect(values.anonKey.split(".")).toHaveLength(3);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("uses an absolute signing_keys_path as-is, without joining the workdir", () =>
      Effect.gen(function* () {
        const jwk = generateRsaJwk();
        yield* writeSigningKeys(tempRoot.current, [jwk]);
        const absolutePath = yield* join(tempRoot.current, "supabase", "signing_keys.json");
        const config = baseConfig({ auth: { signing_keys_path: absolutePath } });
        const values = yield* resolveLocalConfigValues(
          config,
          "127.0.0.1",
          "/some/unrelated/workdir",
        );
        expect(values.anonKey.split(".")).toHaveLength(3);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("still prefers an explicit anon_key/service_role_key over signing keys", () =>
      Effect.gen(function* () {
        yield* writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
        const config = baseConfig({
          auth: {
            signing_keys_path: "signing_keys.json",
            anon_key: "configured-anon",
            service_role_key: "configured-service-role",
          },
        });
        const values = yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
        expect(values.anonKey).toBe("configured-anon");
        expect(values.serviceRoleKey).toBe("configured-service-role");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("falls back to HMAC signing when signing_keys_path resolves to an empty array", () =>
      Effect.gen(function* () {
        yield* writeSigningKeys(tempRoot.current, []);
        const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
        const values = yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
        const [, payload] = values.anonKey.split(".");
        expect(yield* decodeJson(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject(
          {
            iss: "supabase-demo",
          },
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("throws an error when the signing keys file does not exist", () =>
      Effect.gen(function* () {
        const config = baseConfig({ auth: { signing_keys_path: "missing.json" } });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)))
            .message,
        ).toContain("failed to read signing keys: ");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("throws an error when the signing keys file is malformed JSON", () =>
      Effect.gen(function* () {
        const supabaseDir = yield* join(tempRoot.current, "supabase");
        yield* mkdirp(supabaseDir);
        yield* writeFile(yield* join(supabaseDir, "signing_keys.json"), "not valid json");
        const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)))
            .message,
        ).toContain('failed to decode signing keys: JSON Parse error: Unexpected identifier "not"');
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("throws when the first key uses an unsupported algorithm", () =>
      Effect.gen(function* () {
        yield* writeSigningKeys(tempRoot.current, [{ ...generateRsaJwk(), alg: "RS512" }]);
        const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)))
            .message,
        ).toContain("unsupported algorithm: RS512");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("skips reading a missing signing_keys_path when auth is disabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          auth: { enabled: false, signing_keys_path: "missing.json" },
        });
        expect(
          yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
        ).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "skips reading a malformed signing_keys_path when auth is disabled, but still signs asymmetrically with the default key",
      () =>
        Effect.gen(function* () {
          const supabaseDir = yield* join(tempRoot.current, "supabase");
          yield* mkdirp(supabaseDir);
          yield* writeFile(yield* join(supabaseDir, "signing_keys.json"), "not valid json");
          const config = baseConfig({
            auth: { enabled: false, signing_keys_path: "signing_keys.json" },
          });
          const values = yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current);
          // Disabled auth with a configured signing-keys path still signs with the default ES256 key,
          // not HMAC — signing depends on whether keys were loaded, not on auth being enabled.
          const publicKey = yield* Effect.promise(() =>
            importJWK({ ...DEFAULT_SIGNING_KEY, d: undefined, key_ops: undefined }, "ES256"),
          );
          const { payload, protectedHeader } = yield* Effect.promise(() =>
            jwtVerify(values.anonKey, publicKey),
          );
          expect(payload).toMatchObject({ iss: "supabase-demo", role: "anon" });
          expect(protectedHeader).toMatchObject({ alg: "ES256", kid: DEFAULT_SIGNING_KEY.kid });
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  // Required-field/range assertions live in config-validate.unit.test.ts; only env-override
  // mechanics are tested here.

  describe("auth.passkey / auth.webauthn env overrides", () => {
    // `auth.passkey`/`auth.webauthn` have no decoded-schema presence signal, so these tests thread
    // a raw `document` object through explicitly instead of relying on `baseConfig`.

    it.live(
      "throws on an unparsable raw auth.passkey.enabled string instead of silently disabling it",
      () =>
        Effect.gen(function* () {
          const config = baseConfig();
          const document = { auth: { passkey: { enabled: "not-a-bool" } } };
          expect(
            (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)))
              .message,
          ).toContain('"not-a-bool" is not a valid boolean');
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("auth.email.template/notification (content_path validation)", () => {
    const tempRoot = useTempWorkdir("supabase-email-templates-test-");

    it.live("rejects a template content_path pointing at a missing file", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          auth: {
            enabled: true,
            site_url: "http://localhost:3000",
            email: { template: { invite: { content_path: "missing-invite.html" } } },
          },
        });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)))
            .message,
        ).toContain("Invalid config for auth.email.template.invite.content_path: ");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects an absolute template content_path outside the project root", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          auth: {
            enabled: true,
            site_url: "http://localhost:3000",
            email: { template: { invite: { content_path: "/etc/hosts" } } },
          },
        });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)))
            .message,
        ).toContain(
          'Invalid config for auth.email.template.invite.content_path: "/etc/hosts" resolves outside the project root',
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "resolves a relative template content_path against the workdir itself, not <workdir>/supabase",
      () =>
        Effect.gen(function* () {
          yield* writeFile(yield* join(tempRoot.current, "invite.html"), "<html></html>");
          const config = baseConfig({
            auth: {
              enabled: true,
              site_url: "http://localhost:3000",
              email: { template: { invite: { content_path: "invite.html" } } },
            },
          });
          expect(
            yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
          ).toBeDefined();
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not throw a template with no content_path configured", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          auth: {
            enabled: true,
            site_url: "http://localhost:3000",
            email: { template: { invite: {} } },
          },
        });
        expect(
          yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
        ).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects an enabled notification content_path pointing at a missing file", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          auth: {
            enabled: true,
            site_url: "http://localhost:3000",
            email: {
              notification: { password_changed: { enabled: true, content_path: "missing.html" } },
            },
          },
        });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)))
            .message,
        ).toContain("Invalid config for auth.email.notification.password_changed.content_path: ");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("resolves a relative notification content_path against the workdir", () =>
      Effect.gen(function* () {
        const templateDir = yield* join(tempRoot.current, "supabase", "templates");
        yield* mkdirp(templateDir);
        yield* writeFile(yield* join(templateDir, "pw-changed.html"), "<html></html>");
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
        expect(
          yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
        ).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not throw a disabled notification's missing content_path", () =>
      Effect.gen(function* () {
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
        expect(
          yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
        ).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not throw a missing template content_path when auth is disabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          auth: {
            enabled: false,
            email: { template: { invite: { content_path: "missing.html" } } },
          },
        });
        expect(
          yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
        ).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects a template content key present without content_path", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          auth: {
            enabled: true,
            site_url: "http://localhost:3000",
            email: { template: { invite: {} } },
          },
        });
        expect(
          (yield* Effect.flip(
            resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current, {
              auth: { email: { template: { invite: { content: "<html>Hi</html>" } } } },
            }),
          )).message,
        ).toContain(
          "Invalid config for auth.email.template.invite.content: please use content_path instead",
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  // Required-field/range assertions live in config-validate.unit.test.ts; only env-override
  // mechanics are tested here.

  describe("auth.external (external.validate(), D-only, ported to L)", () => {
    // Unmodeled external providers are silently dropped by the decoded config, so this reads the
    // raw `document` (5th param) instead.
    it.live("rejects an enabled unmodeled external provider missing client_id", () =>
      Effect.gen(function* () {
        const config = baseConfig();
        const document = { auth: { external: { custom: { enabled: true } } } };
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)))
            .message,
        ).toContain("Missing required field in config: auth.external.custom.client_id");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects an enabled unmodeled external provider missing secret", () =>
      Effect.gen(function* () {
        const config = baseConfig();
        const document = {
          auth: { external: { custom: { enabled: true, client_id: "abc" } } },
        };
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document)))
            .message,
        ).toContain("Missing required field in config: auth.external.custom.secret");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not require a secret for apple/google providers", () =>
      Effect.gen(function* () {
        const config = baseConfig();
        const document = {
          auth: { external: { apple: { enabled: true, client_id: "abc" } } },
        };
        expect(
          yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document),
        ).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not validate a disabled unmodeled external provider", () =>
      Effect.gen(function* () {
        const config = baseConfig();
        const document = { auth: { external: { custom: { enabled: false } } } };
        expect(
          yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document),
        ).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("skips the check entirely when no document is threaded through", () =>
      Effect.gen(function* () {
        const config = baseConfig();
        expect(yield* resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );
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

    const writeTlsFile = (workdir: string, name: string, contents = "dummy") =>
      Effect.gen(function* () {
        const supabaseDir = yield* join(workdir, "supabase");
        yield* mkdirp(supabaseDir);
        yield* writeFile(yield* join(supabaseDir, name), contents);
      });

    it.live("does not throw when tls.enabled with neither cert_path nor key_path set", () =>
      Effect.gen(function* () {
        const config = baseConfig({ api: { tls: { enabled: true } } });
        expect(
          yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
        ).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    // The "exactly one of cert/key set" checks live in config-validate.unit.test.ts; the file-read
    // behavior below is tested here.

    it.live("throws an error when the configured cert file does not exist", () =>
      Effect.gen(function* () {
        yield* writeTlsFile(tempRoot.current, "key.pem");
        const config = baseConfig({
          api: { tls: { enabled: true, cert_path: "missing-cert.pem", key_path: "key.pem" } },
        });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)))
            .message,
        ).toContain("failed to read TLS cert: ");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("throws an error when the configured key file does not exist", () =>
      Effect.gen(function* () {
        yield* writeTlsFile(tempRoot.current, "cert.pem");
        const config = baseConfig({
          api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "missing-key.pem" } },
        });
        expect(
          (yield* Effect.flip(resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)))
            .message,
        ).toContain("failed to read TLS key: ");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("succeeds when both cert_path and key_path are readable", () =>
      Effect.gen(function* () {
        yield* writeTlsFile(tempRoot.current, "cert.pem");
        yield* writeTlsFile(tempRoot.current, "key.pem");
        const config = baseConfig({
          api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "key.pem" } },
        });
        expect(
          yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
        ).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "resolves cert_path/key_path against <workdir>/supabase unconditionally, no isAbsolute guard",
      () =>
        Effect.gen(function* () {
          yield* writeTlsFile(tempRoot.current, "cert.pem");
          yield* writeTlsFile(tempRoot.current, "key.pem");
          const config = baseConfig({
            api: {
              tls: {
                enabled: true,
                cert_path: "/cert.pem",
                key_path: "/key.pem",
              },
            },
          });
          expect(
            yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
          ).toBeDefined();
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("skips TLS validation entirely when api is disabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          api: { enabled: false, tls: { enabled: true, cert_path: "missing-cert.pem" } },
        });
        expect(
          yield* resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
        ).toBeDefined();
      }).pipe(Effect.provide(BunServices.layer)),
    );
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
        message: 'Invalid config for realtime.ip_version: "v9" must be one of "IPv4", "IPv6"',
      }),
    );
  });
});

describe("resolveLocalJwks", () => {
  const tempRoot = useTempWorkdir("supabase-local-jwks-test-");

  it.live(
    "includes the default ES256 signing key and the oct JWT-secret fallback when no signing_keys_path is configured",
    () =>
      Effect.gen(function* () {
        const config = baseConfig();
        const jwks = yield* runLocalJwks(config, tempRoot.current, "a".repeat(32));
        expect(yield* decodeJson(jwks)).toEqual({
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
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("publishes the public form of every signing key and omits the oct fallback", () =>
    Effect.gen(function* () {
      const jwk = generateRsaJwk();
      yield* writeSigningKeys(tempRoot.current, [jwk]);
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const jwks = yield* runLocalJwks(config, tempRoot.current, "a".repeat(32));
      const parsed = (yield* decodeJson(jwks)) as { keys: ReadonlyArray<Record<string, unknown>> };

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
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("preserves a configured signing key's use/ext and filters key_ops to verify-only", () =>
    Effect.gen(function* () {
      const jwk = { ...generateRsaJwk(), use: "sig", ext: true, key_ops: ["sign", "verify"] };
      yield* writeSigningKeys(tempRoot.current, [jwk]);
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const jwks = yield* runLocalJwks(config, tempRoot.current, "a".repeat(32));
      const parsed = (yield* decodeJson(jwks)) as { keys: ReadonlyArray<Record<string, unknown>> };

      expect(parsed.keys[0]).toMatchObject({ use: "sig", ext: true, key_ops: ["verify"] });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live(
    "falls back to the default ES256 signing key (not the configured file, not the oct fallback) when auth is disabled but signing_keys_path is set",
    () =>
      Effect.gen(function* () {
        yield* writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
        const config = baseConfig({
          auth: { enabled: false, signing_keys_path: "signing_keys.json" },
        });
        const jwks = yield* runLocalJwks(config, tempRoot.current, "a".repeat(32));
        expect(yield* decodeJson(jwks)).toEqual({
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
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("throws an error when the signing keys file does not exist", () =>
    Effect.gen(function* () {
      const config = baseConfig({ auth: { signing_keys_path: "missing.json" } });
      expect(
        (yield* Effect.flip(runLocalJwks(config, tempRoot.current, "a".repeat(32)))).message,
      ).toContain("failed to read signing keys: ");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("throws an error when the signing keys file is malformed JSON", () =>
    Effect.gen(function* () {
      const supabaseDir = yield* join(tempRoot.current, "supabase");
      yield* mkdirp(supabaseDir);
      yield* writeFile(yield* join(supabaseDir, "signing_keys.json"), "not valid json");
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      expect(
        (yield* Effect.flip(runLocalJwks(config, tempRoot.current, "a".repeat(32)))).message,
      ).toContain("failed to decode signing keys: ");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  describe("auth.third_party", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.live("rejects an enabled third-party provider missing its required field", () =>
      Effect.gen(function* () {
        const config = baseConfig({ auth: { third_party: { firebase: { enabled: true } } } });
        expect(
          (yield* Effect.flip(runLocalJwks(config, WORKDIR, "a".repeat(32)))).message,
        ).toContain(
          "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("rejects more than one enabled third-party provider", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          auth: {
            third_party: {
              firebase: { enabled: true, project_id: "my-project" },
              workos: { enabled: true, issuer_url: "https://issuer.example" },
            },
          },
        });
        expect(
          (yield* Effect.flip(runLocalJwks(config, WORKDIR, "a".repeat(32)))).message,
        ).toContain(
          "Invalid config: Only one third_party provider allowed to be enabled at a time.",
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not validate third-party providers when auth is disabled", () =>
      Effect.gen(function* () {
        const remoteKeys = [{ kty: "RSA", kid: "firebase-key", n: "abc", e: "AQAB" }];
        const issuerUrl = "https://securetoken.google.com/my-project";
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url === `${issuerUrl}/.well-known/openid-configuration`) {
            return Promise.resolve(
              new Response(JSON.stringify({ jwks_uri: `${issuerUrl}/jwks.json` }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          if (url === `${issuerUrl}/jwks.json`) {
            return Promise.resolve(
              new Response(JSON.stringify({ keys: remoteKeys }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          return Promise.reject(new Error(`unexpected fetch: ${url}`));
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
        const jwksJson = yield* runLocalJwks(config, WORKDIR, "a".repeat(32));
        const jwks = (yield* decodeJson(jwksJson)) as { keys: ReadonlyArray<{ kid?: string }> };
        expect(jwks.keys.some((key) => key.kid === "firebase-key")).toBe(true);
        fetchMock.mockRestore();
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "does not attempt a remote JWKS fetch for an enabled third-party provider with an empty issuer_url",
      () =>
        Effect.gen(function* () {
          const fetchMock = vi.spyOn(globalThis, "fetch");
          const config = baseConfig({
            auth: {
              enabled: false,
              third_party: { workos: { enabled: true, issuer_url: "" } },
            },
          });

          const jwksJson = yield* runLocalJwks(config, WORKDIR, "a".repeat(32));
          const jwks = (yield* decodeJson(jwksJson)) as { keys: ReadonlyArray<unknown> };

          expect(fetchMock).not.toHaveBeenCalled();
          expect(jwks.keys.length).toBeGreaterThan(0);
          fetchMock.mockRestore();
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fetches and includes the remote JWKS for an enabled third-party provider", () =>
      Effect.gen(function* () {
        const remoteKeys = [{ kty: "RSA", kid: "remote-key", n: "abc", e: "AQAB" }];
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url === "https://issuer.example/.well-known/openid-configuration") {
            return Promise.resolve(
              new Response(JSON.stringify({ jwks_uri: "https://issuer.example/jwks.json" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          if (url === "https://issuer.example/jwks.json") {
            return Promise.resolve(
              new Response(JSON.stringify({ keys: remoteKeys }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          return Promise.reject(new Error(`unexpected fetch url: ${url}`));
        });

        const config = baseConfig({
          auth: {
            third_party: { workos: { enabled: true, issuer_url: "https://issuer.example" } },
          },
        });
        const jwks = yield* runLocalJwks(config, WORKDIR, "a".repeat(32));
        const parsed = (yield* decodeJson(jwks)) as {
          keys: ReadonlyArray<Record<string, unknown>>;
        };

        expect(parsed.keys).toEqual(
          expect.arrayContaining([expect.objectContaining({ kid: "remote-key" })]),
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails the whole resolution when the remote JWKS fetch fails, unlike functions serve's leniency",
      () =>
        Effect.gen(function* () {
          vi.spyOn(globalThis, "fetch").mockImplementation(() =>
            Promise.reject(new Error("oidc discovery failed")),
          );

          const config = baseConfig({
            auth: {
              third_party: { workos: { enabled: true, issuer_url: "https://issuer.example" } },
            },
          });
          expect(
            (yield* Effect.flip(runLocalJwks(config, WORKDIR, "a".repeat(32)))).message,
          ).toContain("Failed to fetch https://issuer.example/.well-known/openid-configuration");
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });
});
