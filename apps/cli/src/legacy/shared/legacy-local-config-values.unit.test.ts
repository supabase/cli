import { generateKeyPairSync } from "node:crypto";

import { ProjectConfigSchema, type ProjectConfig } from "@supabase/config";
import { BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Clock, Data, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { importJWK, jwtVerify } from "jose";
import { afterEach, vi } from "vitest";

import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import { LEGACY_DEFAULT_SIGNING_KEY } from "./legacy-go-jwt.ts";
import {
  LEGACY_POSTGRES_DEFAULT_ROOT_KEY,
  LegacyInvalidBoolEnvOverrideError,
  LegacyInvalidEdgeRuntimePolicyEnvOverrideError,
  LegacyInvalidJwtSecretError,
  LegacyInvalidPoolModeEnvOverrideError,
  LegacyInvalidRealtimeIpVersionEnvOverrideError,
  LegacyInvalidSessionReplicationRoleEnvOverrideError,
  legacyEnvOverrideApiMaxRows,
  legacyEnvOverrideDefaultPoolSize,
  legacyEnvOverrideEdgeRuntimePolicy,
  legacyEnvOverrideMajorVersion,
  legacyEnvOverrideMaxClientConn,
  legacyEnvOverridePoolMode,
  legacyEnvOverrideRealtimeIpVersion,
  legacyEnvOverrideRealtimeMaxHeaderLength,
  legacyRawUnmodeledBool,
  legacyResolveAuthCaptcha,
  legacyResolveAuthEmail,
  legacyResolveAuthEmailSmtp,
  legacyResolveAuthExternalProviders,
  legacyResolveAuthExternalUrl,
  legacyResolveAuthHooks,
  legacyResolveAuthMfa,
  legacyResolveAuthSms,
  legacyResolveConfiguredSigningKeys,
  legacyResolveDbSettingsEnvOverrides,
  legacyResolveLocalConfigValues as resolveLegacyLocalConfigValues,
  legacyResolveLocalJwks,
} from "./legacy-local-config-values.ts";
import { LegacyConfigValidateError } from "./legacy-config-validate.ts";

const decodeConfig = Schema.decodeSync(ProjectConfigSchema);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
class LegacyTestPromiseError extends Data.TaggedError("LegacyTestPromiseError")<{
  readonly cause: unknown;
}> {}
const tryPromiseEffect = <A>(thunk: () => Promise<A>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => new LegacyTestPromiseError({ cause }),
  });
const WORKDIR = "/tmp/legacy-local-config-values-test";
const testPath = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));
const join = (...parts: ReadonlyArray<string>) => testPath.join(...parts);

const testProjectEnvValues: Record<string, string> = {};

function stubEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete testProjectEnvValues[key];
  } else {
    testProjectEnvValues[key] = value;
  }
}

function resolveLocalConfigValues(
  config: ProjectConfig,
  hostname: string,
  workdir: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined = testProjectEnvValues,
  document?: Readonly<Record<string, unknown>>,
  remoteOverrideKeys?: ReadonlySet<string>,
  projectIdFallback?: string,
) {
  return resolveLegacyLocalConfigValues(
    config,
    hostname,
    workdir,
    projectEnvValues ?? testProjectEnvValues,
    document,
    remoteOverrideKeys,
    projectIdFallback,
  ).pipe(
    Effect.provide(BunServices.layer),
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
    Effect.runSync,
  );
}

function resolveLocalConfigValuesEffect(
  config: ProjectConfig,
  hostname: string,
  workdir: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined = testProjectEnvValues,
  document?: Readonly<Record<string, unknown>>,
  remoteOverrideKeys?: ReadonlySet<string>,
  projectIdFallback?: string,
) {
  return resolveLegacyLocalConfigValues(
    config,
    hostname,
    workdir,
    projectEnvValues ?? testProjectEnvValues,
    document,
    remoteOverrideKeys,
    projectIdFallback,
  ).pipe(
    Effect.provide(BunServices.layer),
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
  );
}

afterEach(() => {
  for (const key of Object.keys(testProjectEnvValues)) delete testProjectEnvValues[key];
});

function baseConfig(overrides: Record<string, unknown> = {}): ProjectConfig {
  return decodeConfig({ project_id: "test", ...overrides });
}

/** RSA JWK matching `JWK` struct field names (kty/n/e/d/p/q/dp/dq/qi). */
function generateRsaJwk(): Record<string, unknown> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" });
  return { ...jwk, alg: "RS256", kid: "test-rsa-kid" };
}

function writeSigningKeys(workdir: string, jwks: ReadonlyArray<Record<string, unknown>>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const supabaseDir = join(workdir, "supabase");
    yield* fs.makeDirectory(supabaseDir, { recursive: true });
    yield* fs.writeFileString(join(supabaseDir, "signing_keys.json"), encodeJson(jwks));
  }).pipe(Effect.provide(BunServices.layer));
}

function writeFileEffect(path: string, contents: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(path, contents);
  }).pipe(Effect.provide(BunServices.layer));
}

function makeDirectoryEffect(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path, { recursive: true });
  }).pipe(Effect.provide(BunServices.layer));
}

describe("legacyResolveLocalConfigValues", () => {
  it.effect("reports malformed env overrides through the typed config-validation channel", () =>
    Effect.gen(function* () {
      stubEnv("SUPABASE_API_PORT", "not-a-port");
      const exit = yield* Effect.exit(
        resolveLocalConfigValuesEffect(baseConfig(), "127.0.0.1", WORKDIR),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(
          LegacyConfigValidateError,
        );
        expect(Cause.hasDies(exit.cause)).toBe(false);
      }
    }),
  );

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
    // Byte-exact Go-parity shape is covered by legacy-go-jwt.unit.test.ts; here we
    // only assert the resolver wires the default secret through to both roles.
    const [, anonPayload] = values.anonKey.split(".");
    const [, serviceRolePayload] = values.serviceRoleKey.split(".");
    expect(decodeJson(Buffer.from(anonPayload ?? "", "base64url").toString())).toMatchObject({
      role: "anon",
    });
    expect(decodeJson(Buffer.from(serviceRolePayload ?? "", "base64url").toString())).toMatchObject(
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
    // Go's Config.Validate fails this at config-load time, before any command
    // can render output — reproduced as a thrown
    // error here rather than silently signing with the too-short secret.
    const config = baseConfig({ auth: { jwt_secret: "a".repeat(15) } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      LegacyInvalidJwtSecretError,
    );
  });

  describe("encrypted auth secrets", () => {
    // A known-good test vector: this ciphertext
    // decrypts to "value" under the keypair below.
    const VAULT_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
    const VAULT_ENCRYPTED =
      "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

    afterEach(() => {
      stubEnv("DOTENV_PRIVATE_KEY", undefined);
    });

    it("decrypts an encrypted: jwt_secret when DOTENV_PRIVATE_KEY is set", () => {
      // "value" is only 5 characters, shorter than Go's minimum JWT secret length,
      // so pad it out the way a real deployment's decrypted secret would be sized.
      stubEnv("DOTENV_PRIVATE_KEY", VAULT_PRIVATE_KEY);
      const config = baseConfig({ auth: { jwt_secret: VAULT_ENCRYPTED } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        LegacyInvalidJwtSecretError,
      );
    });

    it("decrypts an encrypted: publishable_key when DOTENV_PRIVATE_KEY is set", () => {
      stubEnv("DOTENV_PRIVATE_KEY", VAULT_PRIVATE_KEY);
      const config = baseConfig({ auth: { publishable_key: VAULT_ENCRYPTED } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.publishableKey).toBe("value");
    });

    it("fails config loading for an encrypted: secret with no private key, matching Go", () => {
      // Go aborts the whole command with `failed to parse config: <error>` rather
      // than silently using the ciphertext as literal key material.
      const config = baseConfig({ auth: { publishable_key: VAULT_ENCRYPTED } });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "failed to parse config: missing private key",
      );
    });

    it("decrypts an encrypted: auth.email.smtp.pass, matching Go's Secret-typed Smtp.Pass field", () => {
      stubEnv("DOTENV_PRIVATE_KEY", VAULT_PRIVATE_KEY);
      const document = { auth: { email: { smtp: { enabled: true, pass: VAULT_ENCRYPTED } } } };
      const resolved = legacyResolveAuthEmailSmtp(document.auth, testProjectEnvValues);
      expect(resolved?.pass).toBe("value");
    });

    it("decrypts an encrypted: studio.openai_api_key, matching Go's Secret-typed OpenaiApiKey field", () => {
      stubEnv("DOTENV_PRIVATE_KEY", VAULT_PRIVATE_KEY);
      const config = baseConfig({ studio: { openai_api_key: VAULT_ENCRYPTED } });
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
      expect(values.openaiApiKey).toBe("value");
    });

    it("decrypts an encrypted: SUPABASE_AUTH_* env override, not just the config.toml value", () => {
      // Go's decrypt hook runs on whatever value reaches the config.Secret field,
      // whether it was sourced from config.toml or a Viper env override.
      const config = baseConfig();
      const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, {
        DOTENV_PRIVATE_KEY: VAULT_PRIVATE_KEY,
        SUPABASE_AUTH_SECRET_KEY: VAULT_ENCRYPTED,
      });
      expect(values.secretKey).toBe("value");
      stubEnv("DOTENV_PRIVATE_KEY", undefined);
    });

    it("rejects an explicit empty project_id, matching Go's Config.Validate", () => {
      // Go's Config.Validate checks ProjectId first, before any other field.
      // The workdir-basename default is merged
      // in as a viper default BEFORE config.toml is merged, so an explicit
      // `project_id = ""` in the file overwrites that default with the literal
      // empty string rather than being treated as absent — Go fails outright.
      const config = baseConfig({ project_id: "" });
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: project_id",
      );
    });

    it("does not reject an absent project_id when the workdir basename sanitizes to a non-empty value", () => {
      const config = Schema.decodeSync(ProjectConfigSchema)({});
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });

    it("rejects an absent project_id when the workdir basename sanitizes to empty, matching Go", () => {
      // `mergeDefaultValues` merges `sanitizeProjectId(filepath.Base(cwd))` in as a viper
      // DEFAULT before config.toml is merged —
      // so `c.ProjectId` is never Go's zero value by the time `Validate` runs. A workdir whose
      // basename sanitizes to `""` (every character invalid, e.g. `!!!`) therefore still fails
      // config loading in Go even with no `project_id` key in the file at all.
      const config = Schema.decodeSync(ProjectConfigSchema)({});
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", "/tmp/!!!")).toThrow(
        "Missing required field in config: project_id",
      );
    });

    it("lets SUPABASE_PROJECT_ID override an absent project_id whose basename sanitizes to empty", () => {
      const config = Schema.decodeSync(ProjectConfigSchema)({});
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", "/tmp/!!!", {
          SUPABASE_PROJECT_ID: "env-project",
        }),
      ).not.toThrow();
    });

    it("lets SUPABASE_PROJECT_ID override an explicit empty project_id", () => {
      // Viper's AutomaticEnv binds SUPABASE_PROJECT_ID with higher precedence
      // than config.toml, so a non-empty env override must
      // win even when the file's project_id is explicitly empty.
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
      const tempRoot = useLegacyTempWorkdir("supabase-signing-keys-env-override-test-");

      // Go's Config.Load binds Viper with SetEnvPrefix("SUPABASE") + AutomaticEnv() —
      // env vars take precedence over config.toml.
      const ENV_KEYS = [
        "SUPABASE_AUTH_JWT_SECRET",
        "SUPABASE_AUTH_PUBLISHABLE_KEY",
        "SUPABASE_AUTH_SECRET_KEY",
        "SUPABASE_AUTH_ANON_KEY",
        "SUPABASE_AUTH_SERVICE_ROLE_KEY",
        "SUPABASE_AUTH_SIGNING_KEYS_PATH",
      ] as const;

      afterEach(() => {
        for (const key of ENV_KEYS) stubEnv(key, undefined);
      });

      it("overrides jwt_secret even when config.toml sets one", () => {
        stubEnv("SUPABASE_AUTH_JWT_SECRET", "b".repeat(32));
        const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.jwtSecret).toBe("b".repeat(32));
      });

      it("overrides publishable_key/secret_key", () => {
        stubEnv("SUPABASE_AUTH_PUBLISHABLE_KEY", "env-publishable");
        stubEnv("SUPABASE_AUTH_SECRET_KEY", "env-secret");
        const config = baseConfig({
          auth: { publishable_key: "config-publishable", secret_key: "config-secret" },
        });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.publishableKey).toBe("env-publishable");
        expect(values.secretKey).toBe("env-secret");
      });

      it("overrides anon_key/service_role_key", () => {
        stubEnv("SUPABASE_AUTH_ANON_KEY", "env-anon");
        stubEnv("SUPABASE_AUTH_SERVICE_ROLE_KEY", "env-service-role");
        const config = baseConfig({
          auth: { anon_key: "config-anon", service_role_key: "config-service-role" },
        });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.anonKey).toBe("env-anon");
        expect(values.serviceRoleKey).toBe("env-service-role");
      });

      it("treats an empty env var as unset, matching Viper's default", () => {
        stubEnv("SUPABASE_AUTH_JWT_SECRET", "");
        const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.jwtSecret).toBe("a".repeat(32));
      });

      it("still applies the short-secret validation to an env-provided jwt_secret", () => {
        stubEnv("SUPABASE_AUTH_JWT_SECRET", "too-short");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          LegacyInvalidJwtSecretError,
        );
      });

      it.effect("overrides signing_keys_path even when config.toml doesn't set one", () =>
        Effect.gen(function* () {
          const jwk = generateRsaJwk();
          yield* writeSigningKeys(tempRoot.current, [jwk]);
          stubEnv("SUPABASE_AUTH_SIGNING_KEYS_PATH", "signing_keys.json");
          const config = baseConfig();
          const values = yield* resolveLocalConfigValuesEffect(
            config,
            "127.0.0.1",
            tempRoot.current,
          );

          const publicJwk = { ...jwk, d: undefined, p: undefined, q: undefined, dp: undefined };
          const publicKey = yield* tryPromiseEffect(() => importJWK(publicJwk, "RS256"));
          const { protectedHeader } = yield* tryPromiseEffect(() =>
            jwtVerify(values.anonKey, publicKey),
          );
          expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "test-rsa-kid" });
        }),
      );

      it.effect("prefers an env-provided signing_keys_path over config.toml's", () =>
        Effect.gen(function* () {
          const envJwk = { ...generateRsaJwk(), kid: "env-kid" };
          const configJwk = { ...generateRsaJwk(), kid: "config-kid" };
          yield* writeSigningKeys(tempRoot.current, [envJwk]);
          const supabaseDir = join(tempRoot.current, "supabase");
          yield* writeFileEffect(join(supabaseDir, "other_keys.json"), encodeJson([configJwk]));
          stubEnv("SUPABASE_AUTH_SIGNING_KEYS_PATH", "signing_keys.json");
          const config = baseConfig({ auth: { signing_keys_path: "other_keys.json" } });
          const values = yield* resolveLocalConfigValuesEffect(
            config,
            "127.0.0.1",
            tempRoot.current,
          );
          const [header] = values.anonKey.split(".");
          expect(decodeJson(Buffer.from(header ?? "", "base64url").toString())).toMatchObject({
            kid: "env-kid",
          });
        }),
      );
    });

    describe("SUPABASE_* env(VAR) indirection (Go's LoadEnvHook)", () => {
      // `LoadEnvHook` is
      // the first mapstructure decode hook composed into `v.UnmarshalExact`,
      // so it resolves a nested `env(VAR)`
      // reference on ANY string mapstructure decodes into the struct — including
      // a `SUPABASE_*` env-override value itself, not just a `config.toml`
      // literal. `envOverride`'s callers (string/port/bool fields) must all see
      // that same resolution.
      const ENV_KEYS = ["SUPABASE_AUTH_JWT_SECRET", "SUPABASE_DB_PORT", "SUPABASE_API_ENABLED"];

      afterEach(() => {
        for (const key of ENV_KEYS) stubEnv(key, undefined);
        stubEnv("INDIRECT_JWT_SECRET", undefined);
        stubEnv("INDIRECT_DB_PORT", undefined);
        stubEnv("INDIRECT_API_ENABLED", undefined);
      });

      it("resolves a string override's env(VAR) indirection", () => {
        stubEnv("SUPABASE_AUTH_JWT_SECRET", "env(INDIRECT_JWT_SECRET)");
        stubEnv("INDIRECT_JWT_SECRET", "c".repeat(32));
        const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.jwtSecret).toBe("c".repeat(32));
      });

      it("resolves a port override's env(VAR) indirection", () => {
        stubEnv("SUPABASE_DB_PORT", "env(INDIRECT_DB_PORT)");
        stubEnv("INDIRECT_DB_PORT", "54329");
        const config = baseConfig({ db: { port: 54322 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54329/postgres");
      });

      it("resolves a bool override's env(VAR) indirection", () => {
        stubEnv("SUPABASE_API_ENABLED", "env(INDIRECT_API_ENABLED)");
        stubEnv("INDIRECT_API_ENABLED", "false");
        const config = baseConfig({
          api: { enabled: true, tls: { enabled: true, cert_path: "missing-cert.pem" } },
        });
        // If the bool override weren't resolved through the indirection, the
        // literal "env(INDIRECT_API_ENABLED)" string would fail Go's
        // strconv.ParseBool acceptance set and throw LegacyInvalidBoolEnvOverrideError;
        // resolving it to "false" disables api.enabled and skips the TLS check
        // that would otherwise throw on the missing cert file.
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      it("preserves the env(VAR) literal when the indirected var is unset, matching Go", () => {
        stubEnv("SUPABASE_AUTH_JWT_SECRET", "env(INDIRECT_JWT_SECRET)");
        const config = baseConfig({ auth: { jwt_secret: "a".repeat(32) } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        // Go's LoadEnvHook only substitutes when the target var is non-empty —
        // an unset indirection leaves the literal
        // `env(VAR)` string, same as an unresolved config.toml-level reference.
        expect(values.jwtSecret).toBe("env(INDIRECT_JWT_SECRET)");
      });
    });

    describe("non-auth SUPABASE_* env overrides", () => {
      // Go's Config.Load binds Viper with SetEnvPrefix("SUPABASE") + AutomaticEnv()
      // generically across the whole config struct,
      // not just auth fields — this is also exercised against
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
        for (const key of ENV_KEYS) stubEnv(key, undefined);
      });

      it("overrides db.port for the derived DB URL and the exposed dbPort", () => {
        stubEnv("SUPABASE_DB_PORT", "54329");
        const config = baseConfig({ db: { port: 54322 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54329/postgres");
        expect(values.dbPort).toBe(54329);
      });

      it("overrides studio.port for the derived Studio URL", () => {
        stubEnv("SUPABASE_STUDIO_PORT", "54330");
        const config = baseConfig({ studio: { port: 54323 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.studioUrl).toBe("http://127.0.0.1:54330");
      });

      it("overrides local_smtp.port for the derived Mailpit URL", () => {
        stubEnv("SUPABASE_LOCAL_SMTP_PORT", "54331");
        const config = baseConfig({ local_smtp: { port: 54324 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.mailpitUrl).toBe("http://127.0.0.1:54331");
      });

      it("overrides api.port for every API-derived URL", () => {
        stubEnv("SUPABASE_API_PORT", "54332");
        const config = baseConfig({ api: { port: 54321 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.apiUrl).toBe("http://127.0.0.1:54332");
        expect(values.restUrl).toBe("http://127.0.0.1:54332/rest/v1");
      });

      it("overrides api.external_url even when config.toml sets one", () => {
        stubEnv("SUPABASE_API_EXTERNAL_URL", "https://env-override.example");
        const config = baseConfig({ api: { external_url: "https://config.example" } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.apiUrl).toBe("https://env-override.example");
      });

      it("treats an empty non-auth env var as unset, matching Viper's default", () => {
        stubEnv("SUPABASE_DB_PORT", "");
        const config = baseConfig({ db: { port: 54322 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
      });

      // Go's Config.Load decodes `SUPABASE_*_PORT` overrides as `uint16` via
      // Viper's UnmarshalExact (WeaklyTypedInput
      // decodes the override string with strconv.ParseUint and hard-fails on a
      // malformed value) rather than silently producing a `NaN`-laced URL.
      it.each([
        "SUPABASE_DB_PORT",
        "SUPABASE_STUDIO_PORT",
        "SUPABASE_LOCAL_SMTP_PORT",
        "SUPABASE_API_PORT",
      ] as const)("rejects a malformed %s override instead of producing NaN", (envKey) => {
        stubEnv(envKey, "abc");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          LegacyConfigValidateError,
        );
      });

      it("rejects a SUPABASE_DB_PORT override above the uint16 range", () => {
        stubEnv("SUPABASE_DB_PORT", "99999");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          LegacyConfigValidateError,
        );
      });

      // Go's `strconv.ParseUint(str, 0, 16)` (base 0) auto-detects octal/hex/binary literals for
      // `SUPABASE_*_PORT` overrides too — same base-0 grammar as `legacyEnvOverrideUint`
      // (`parseGoBaseZeroUint`), just capped at `uint16` instead of `uint64`. The old
      // `/^\d+$/`-plus-`Number()` parsing silently misread a bare-leading-zero override as decimal
      // instead of octal, and rejected a `0x`-prefixed override outright even though Go accepts it.
      it("resolves an octal leading-zero SUPABASE_DB_PORT override to its octal value, not decimal", () => {
        stubEnv("SUPABASE_DB_PORT", "010");
        const config = baseConfig({ db: { port: 54322 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.dbPort).toBe(8);
        expect(values.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:8/postgres");
      });

      it("resolves a 0x-prefixed SUPABASE_DB_PORT override as hex", () => {
        stubEnv("SUPABASE_DB_PORT", "0x1F90");
        const config = baseConfig({ db: { port: 54322 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.dbPort).toBe(8080);
      });

      it("still resolves a plain decimal SUPABASE_DB_PORT override with no leading zero", () => {
        stubEnv("SUPABASE_DB_PORT", "5432");
        const config = baseConfig({ db: { port: 54322 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.dbPort).toBe(5432);
      });

      it("rejects a 0x-prefixed SUPABASE_DB_PORT override exceeding the uint16 range", () => {
        stubEnv("SUPABASE_DB_PORT", "0x1FFFF");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          LegacyConfigValidateError,
        );
      });

      // Unlike the malformed/out-of-range cases above (a decode-time hard-fail,
      // uniform across all four SUPABASE_*_PORT fields), db.port=0 is a
      // Config.Validate-time hard-fail specific to db.port: it has no `enabled`
      // gate in Go, unlike api.port/studio.port/local_smtp.port.
      it("rejects a zero SUPABASE_DB_PORT override, matching Go's required-field check", () => {
        stubEnv("SUPABASE_DB_PORT", "0");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: db.port",
        );
      });

      // Unlike db.port, Go gates the api.port===0 rejection on api.enabled —
      // api.enabled defaults to true, so a
      // configured or env-overridden zero port is rejected by default.
      it("rejects a configured api.port of 0 when api is enabled", () => {
        const config = baseConfig({ api: { port: 0 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: api.port",
        );
      });

      it("rejects a zero SUPABASE_API_PORT override when api is enabled", () => {
        stubEnv("SUPABASE_API_PORT", "0");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: api.port",
        );
      });

      it("does not reject a zero api.port when api is disabled", () => {
        const config = baseConfig({ api: { enabled: false, port: 0 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      // Go gates the studio.port===0 rejection on studio.enabled,
      // same pattern as api.port above.
      // studio.enabled defaults to true, so a configured or env-overridden zero
      // port is rejected by default.
      it("rejects a configured studio.port of 0 when studio is enabled", () => {
        const config = baseConfig({ studio: { port: 0 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: studio.port",
        );
      });

      it("rejects a zero SUPABASE_STUDIO_PORT override when studio is enabled", () => {
        stubEnv("SUPABASE_STUDIO_PORT", "0");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: studio.port",
        );
      });

      it("does not reject a zero studio.port when studio is disabled", () => {
        const config = baseConfig({ studio: { enabled: false, port: 0 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      // Go's Config.Validate parses studio.api_url with net/url.Parse right
      // after the port check, still inside `if c.Studio.Enabled`.
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
        stubEnv("SUPABASE_STUDIO_API_URL", "http://[::1");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          `Invalid config for studio.api_url: parse "http://[::1": missing ']' in host`,
        );
      });

      // Go gates the local_smtp.port===0 rejection on local_smtp.enabled (Go's
      // struct field is still named `Inbucket` for the `[local_smtp]` TOML
      // section), same pattern as api.port/
      // studio.port above. local_smtp.enabled defaults to true, so a configured
      // or env-overridden zero port is rejected by default.
      it("rejects a configured local_smtp.port of 0 when local_smtp is enabled", () => {
        const config = baseConfig({ local_smtp: { port: 0 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: local_smtp.port",
        );
      });

      it("rejects a zero SUPABASE_LOCAL_SMTP_PORT override when local_smtp is enabled", () => {
        stubEnv("SUPABASE_LOCAL_SMTP_PORT", "0");
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
      // The pure 0/12/13-17/generic-invalid assertions moved to
      // `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig` calls) —
      // only the SUPABASE_DB_MAJOR_VERSION env-override mechanics stay here.
      afterEach(() => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", undefined);
      });

      it("overrides a valid configured major_version via SUPABASE_DB_MAJOR_VERSION", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "15");
        const config = baseConfig({ db: { major_version: 17 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      it("rejects an unsupported SUPABASE_DB_MAJOR_VERSION override", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "16");
        const config = baseConfig({ db: { major_version: 17 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Failed reading config: Invalid db.major_version: 16.",
        );
      });

      it("rejects a non-numeric SUPABASE_DB_MAJOR_VERSION override", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "abc");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Failed reading config: Invalid db.major_version: abc.",
        );
      });

      it("treats an empty SUPABASE_DB_MAJOR_VERSION override as unset, matching Viper's default", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "");
        const config = baseConfig({ db: { major_version: 17 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });
    });

    describe("SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED env override", () => {
      // `[db.network_restrictions]` ships uncommented in Go's default template and
      // `NetworkRestrictions` is a plain, non-pointer `db` struct field, so Viper always registers a
      // default and decodes this override unconditionally during `Config.Load` — same bucket as
      // `db.port`/`db.major_version` above, validated eagerly rather than skipped.
      afterEach(() => {
        stubEnv("SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED", undefined);
      });

      it("does not throw for a valid SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED override", () => {
        stubEnv("SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED", "true");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      it("rejects a malformed SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED override", () => {
        stubEnv("SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED", "notabool");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          'Invalid config for db.network_restrictions.enabled: cannot parse "notabool" as a bool',
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
        expect(values.rootKey).toBe(LEGACY_POSTGRES_DEFAULT_ROOT_KEY);
      });

      it("uses a configured string root_key verbatim", () => {
        const config = baseConfig();
        const document = { db: { root_key: "custom-root-key" } };
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document);
        expect(values.rootKey).toBe("custom-root-key");
      });

      it("rejects a non-string root_key (e.g. a bare TOML integer), matching Go's Secret decode failure", () => {
        // `db.root_key` isn't modeled in `@supabase/config`'s schema, so Go's own
        // decode failure (mapstructure rejecting a scalar into the `Secret` struct)
        // must be reproduced here rather than letting the raw
        // number flow unguarded into `envOverride`/`legacyDecryptAuthSecret`.
        const config = baseConfig();
        const document = { db: { root_key: 12345 } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).toThrow(
          "failed to parse config: decoding failed due to the following error(s):\n\n'db.root_key' expected a map or struct",
        );
      });
    });

    // Go's Config.Validate runs ValidateBucketName over every [storage.buckets.*]
    // key right after db.major_version, unconditionally — there is no
    // storage.enabled-style gate.
    //
    // Moved to `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig`
    // calls) — this section has no L-specific derivation or env-override mechanics of its own.

    // Go's Config.Validate rejects an invalid edge_runtime.deno_version
    // unconditionally — NOT gated on edge_runtime.enabled.
    describe("edge_runtime.deno_version (required field in config)", () => {
      // The pure 0/1/2/generic-invalid/disabled assertions moved to
      // `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig` calls) —
      // only the SUPABASE_EDGE_RUNTIME_DENO_VERSION env-override mechanics stay here.
      afterEach(() => {
        stubEnv("SUPABASE_EDGE_RUNTIME_DENO_VERSION", undefined);
      });

      it("rejects a zero SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
        stubEnv("SUPABASE_EDGE_RUNTIME_DENO_VERSION", "0");
        const config = baseConfig({ edge_runtime: { deno_version: 2 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: edge_runtime.deno_version",
        );
      });

      it("rejects an unsupported SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
        stubEnv("SUPABASE_EDGE_RUNTIME_DENO_VERSION", "3");
        const config = baseConfig({ edge_runtime: { deno_version: 2 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Failed reading config: Invalid edge_runtime.deno_version: 3.",
        );
      });

      it("rejects a non-numeric SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
        stubEnv("SUPABASE_EDGE_RUNTIME_DENO_VERSION", "abc");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Failed reading config: Invalid edge_runtime.deno_version: abc.",
        );
      });

      it("treats an empty SUPABASE_EDGE_RUNTIME_DENO_VERSION override as unset, matching Viper's default", () => {
        stubEnv("SUPABASE_EDGE_RUNTIME_DENO_VERSION", "");
        const config = baseConfig({ edge_runtime: { deno_version: 2 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });
    });

    describe("analytics (BigQuery backend required fields)", () => {
      // `Config.Validate` validates `[analytics]` right after
      // `edge_runtime.deno_version`: when
      // `analytics.enabled` and `analytics.backend == "bigquery"`, all three GCP
      // fields are required, checked in that order.
      //
      // The pure required-field/complete/disabled assertions moved to
      // `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig` calls) —
      // only the SUPABASE_ANALYTICS_* env-override mechanics stay here.
      afterEach(() => {
        stubEnv("SUPABASE_ANALYTICS_ENABLED", undefined);
        stubEnv("SUPABASE_ANALYTICS_BACKEND", undefined);
        stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_ID", undefined);
        stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER", undefined);
        stubEnv("SUPABASE_ANALYTICS_GCP_JWT_PATH", undefined);
      });

      it("rejects a bigquery backend enabled only via SUPABASE_ANALYTICS_ENABLED", () => {
        stubEnv("SUPABASE_ANALYTICS_ENABLED", "true");
        const config = baseConfig({ analytics: { enabled: false, backend: "bigquery" } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: analytics.gcp_project_id",
        );
      });

      it("rejects a bigquery backend selected only via SUPABASE_ANALYTICS_BACKEND", () => {
        stubEnv("SUPABASE_ANALYTICS_BACKEND", "bigquery");
        const config = baseConfig({ analytics: { enabled: true, backend: "postgres" } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Missing required field in config: analytics.gcp_project_id",
        );
      });

      it("accepts env-provided GCP fields overriding empty config.toml values", () => {
        stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_ID", "proj");
        stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER", "123");
        stubEnv("SUPABASE_ANALYTICS_GCP_JWT_PATH", "gcp.json");
        const config = baseConfig({ analytics: { enabled: true, backend: "bigquery" } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      // `LogflareBackend.UnmarshalText` hard-rejects any
      // `analytics.backend` value outside `postgres`/`bigquery` during the same
      // `UnmarshalExact` decode every `SUPABASE_*` override goes through —
      // a malformed `SUPABASE_ANALYTICS_BACKEND` fails
      // config loading outright, same mechanism as the port/bool overrides below.
      it("rejects an invalid SUPABASE_ANALYTICS_BACKEND override", () => {
        stubEnv("SUPABASE_ANALYTICS_BACKEND", "mysql");
        const config = baseConfig({ analytics: { enabled: true, backend: "postgres" } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          LegacyConfigValidateError,
        );
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          'Invalid config for analytics.backend: cannot parse "mysql" as one of "postgres", "bigquery"',
        );
      });
    });

    describe("experimental.* (experimental.validate())", () => {
      // `(e *experimental) validate()`,
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
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      // `experimental.webhooks.enabled`/`experimental.pgdelta.format_options` are Viper-bound like
      // any other leaf field once `[experimental]` is present (`ExperimentalBindStruct`/
      // `AutomaticEnv`) — same SUPABASE_*-env-override MECHANICS split as
      // `auth.captcha`/`auth.passkey` above: the required-field/JSON-shape checks themselves live in
      // `legacy-config-validate.unit.test.ts`, only the env-override wiring is exercised here.
      afterEach(() => {
        stubEnv("SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED", undefined);
        stubEnv("SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS", undefined);
      });

      it("enables webhooks purely via SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED when the section omits enabled", () => {
        stubEnv("SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED", "true");
        const config = baseConfig({ experimental: { webhooks: {} } });
        const document = { experimental: { webhooks: {} } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).not.toThrow();
      });

      it("rejects a malformed SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED override on an already-enabled section", () => {
        stubEnv("SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED", "notabool");
        const config = baseConfig({ experimental: { webhooks: { enabled: true } } });
        const document = { experimental: { webhooks: { enabled: true } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).toThrow(
          'Invalid config for experimental.webhooks.enabled: cannot parse "notabool" as a bool',
        );
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).toThrow(
          'Invalid config for experimental.webhooks.enabled: cannot parse "notabool" as a bool',
        );
      });

      it("rejects an invalid JSON SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS override", () => {
        stubEnv("SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS", "{not valid json");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
        );
      });

      it("accepts a valid JSON SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS override", () => {
        stubEnv("SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS", '{"keywordCase":"upper"}');
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      it("suppresses a malformed SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS when a remote block already set experimental.pgdelta.format_options (review: PRRT_kwDOErm0O86XLe6o)", () => {
        // Same `experimental.webhooks.enabled` bug class, just for the OTHER Viper-bound
        // `[experimental]` leaf this resolver derives: `experimental.pgdelta.format_options` is
        // ALSO in `LEGACY_ENV_OVERRIDABLE_KEYS`, so a matched `[remotes.<ref>]` block's own valid
        // value must win over a malformed ambient env override, matching `mergeRemoteConfig`
        // (`v.Set` above `AutomaticEnv`).
        stubEnv("SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS", "{not valid json");
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
      // Go applies the Viper-bound `api.tls.enabled` override
      // BEFORE deriving the default `api.external_url` scheme,
      // so an ambient/dotenv override flips http/https even when config.toml says
      // otherwise.
      afterEach(() => {
        stubEnv("SUPABASE_API_TLS_ENABLED", undefined);
      });

      it("overrides api.tls.enabled from false to true", () => {
        stubEnv("SUPABASE_API_TLS_ENABLED", "true");
        const config = baseConfig({ api: { tls: { enabled: false }, port: 54321 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.apiUrl).toBe("https://127.0.0.1:54321");
      });

      it("overrides api.tls.enabled from true to false", () => {
        stubEnv("SUPABASE_API_TLS_ENABLED", "false");
        const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.apiUrl).toBe("http://127.0.0.1:54321");
      });

      it("does not override api.tls.enabled once api.external_url is set", () => {
        stubEnv("SUPABASE_API_TLS_ENABLED", "true");
        const config = baseConfig({ api: { external_url: "http://config.example" } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.apiUrl).toBe("http://config.example");
      });

      it("rejects a malformed override instead of falling back to the configured value", () => {
        stubEnv("SUPABASE_API_TLS_ENABLED", "not-a-bool");
        const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          'Invalid config for api.tls.enabled: cannot parse "not-a-bool" as a bool',
        );
      });

      it("treats an empty override as unset, matching Viper's default", () => {
        stubEnv("SUPABASE_API_TLS_ENABLED", "");
        const config = baseConfig({ api: { tls: { enabled: true }, port: 54321 } });
        const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
        expect(values.apiUrl).toBe("https://127.0.0.1:54321");
      });
    });

    describe("legacyEnvOverrideRealtimeIpVersion", () => {
      afterEach(() => {
        stubEnv("SUPABASE_REALTIME_IP_VERSION", undefined);
      });

      it("falls back to the configured value when unset", () => {
        expect(legacyEnvOverrideRealtimeIpVersion("IPv4", testProjectEnvValues)).toBe("IPv4");
      });

      it("overrides IPv4 to IPv6 via the env var", () => {
        stubEnv("SUPABASE_REALTIME_IP_VERSION", "IPv6");
        expect(legacyEnvOverrideRealtimeIpVersion("IPv4", testProjectEnvValues)).toBe("IPv6");
      });

      // `AddressFamily.UnmarshalText` hard-rejects
      // any value outside `{IPv4, IPv6}` during the same `UnmarshalExact` decode every
      // `SUPABASE_*` override goes through, same mechanism as the analytics backend override.
      it("rejects an invalid override instead of falling back to the configured value", () => {
        stubEnv("SUPABASE_REALTIME_IP_VERSION", "IPv5");
        expect(() => legacyEnvOverrideRealtimeIpVersion("IPv4", testProjectEnvValues)).toThrow(
          LegacyInvalidRealtimeIpVersionEnvOverrideError,
        );
        expect(() => legacyEnvOverrideRealtimeIpVersion("IPv4", testProjectEnvValues)).toThrow(
          'Invalid config for realtime.ip_version: cannot parse "IPv5" as one of "IPv4", "IPv6"',
        );
      });
    });

    describe("legacyEnvOverrideRealtimeMaxHeaderLength", () => {
      afterEach(() => {
        stubEnv("SUPABASE_REALTIME_MAX_HEADER_LENGTH", undefined);
      });

      it("falls back to the configured value when unset", () => {
        expect(legacyEnvOverrideRealtimeMaxHeaderLength(4096, testProjectEnvValues)).toBe(4096);
      });

      it("overrides the configured value via the env var", () => {
        stubEnv("SUPABASE_REALTIME_MAX_HEADER_LENGTH", "8192");
        expect(legacyEnvOverrideRealtimeMaxHeaderLength(4096, testProjectEnvValues)).toBe(8192);
      });

      it("also honors a projectEnvValues (dotenv) value", () => {
        expect(
          legacyEnvOverrideRealtimeMaxHeaderLength(4096, {
            SUPABASE_REALTIME_MAX_HEADER_LENGTH: "16384",
          }),
        ).toBe(16384);
      });

      // `uint` is 64 bits wide on every platform this CLI ships for, decoded via
      // mapstructure's `decodeUint` (`strconv.ParseUint(str, 0, 64)`) under Viper's
      // `WeaklyTypedInput: true`. A value one past `2^64-1` genuinely fails that parse in Go, so
      // it must be rejected here too instead of silently losing precision through `Number(value)`.
      it("rejects an override exceeding the uint64 max (2^64), matching Go's ParseUint failure", () => {
        stubEnv("SUPABASE_REALTIME_MAX_HEADER_LENGTH", "18446744073709551616");
        expect(() => legacyEnvOverrideRealtimeMaxHeaderLength(4096, testProjectEnvValues)).toThrow(
          "Failed reading config: Invalid realtime.max_header_length: 18446744073709551616.",
        );
      });

      // Guards against an overcorrected fix that used an imprecise `Number`-based bound and
      // rejected values Go itself still accepts.
      it("accepts an override of exactly the uint64 max (2^64-1)", () => {
        stubEnv("SUPABASE_REALTIME_MAX_HEADER_LENGTH", "18446744073709551615");
        expect(() =>
          legacyEnvOverrideRealtimeMaxHeaderLength(4096, testProjectEnvValues),
        ).not.toThrow();
      });

      // Guards against the base-0 grammar rewrite (`parseGoBaseZeroUint`) silently
      // reintroducing precision loss or an unbounded parse for a non-decimal literal —
      // `0x10000000000000000` is exactly 2^64, one past `LEGACY_UINT_MAX`, same as the
      // decimal literal above, just routed through the hex branch instead of the plain
      // decimal branch.
      it("rejects a hex override exceeding the uint64 max (2^64), matching Go's ParseUint failure", () => {
        stubEnv("SUPABASE_REALTIME_MAX_HEADER_LENGTH", "0x10000000000000000");
        expect(() => legacyEnvOverrideRealtimeMaxHeaderLength(4096, testProjectEnvValues)).toThrow(
          "Failed reading config: Invalid realtime.max_header_length: 0x10000000000000000.",
        );
      });
    });

    describe("legacyEnvOverrideApiMaxRows", () => {
      afterEach(() => {
        stubEnv("SUPABASE_API_MAX_ROWS", undefined);
      });

      it("falls back to the configured value when unset", () => {
        expect(legacyEnvOverrideApiMaxRows(1000, testProjectEnvValues)).toBe(1000);
      });

      it("overrides the configured value via the env var", () => {
        stubEnv("SUPABASE_API_MAX_ROWS", "500");
        expect(legacyEnvOverrideApiMaxRows(1000, testProjectEnvValues)).toBe(500);
      });
    });

    // `legacyEnvOverrideMajorVersion` is exercised directly (rather than through the
    // full `legacyResolveLocalConfigValues` pipeline, as the "db.major_version (required
    // field in config)" describe block above does) so these assertions cover only
    // `legacyEnvOverrideUint`'s base-0 grammar parsing, not `legacyValidateResolvedConfig`'s
    // separate "is this a supported Postgres major version" switch — most of the octal/hex/
    // binary literals below don't correspond to a supported major version and would fail
    // that unrelated downstream check even once correctly parsed.
    describe("legacyEnvOverrideMajorVersion", () => {
      afterEach(() => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", undefined);
      });

      it("falls back to the configured value when unset", () => {
        expect(legacyEnvOverrideMajorVersion(17, testProjectEnvValues)).toBe(17);
      });

      // Go's `strconv.ParseUint(str, 0, 64)` treats a bare leading zero followed by more
      // digits as octal, not decimal — `"010"` is `8`, not `10` — a silent value
      // divergence the old `/^\d+$/`-plus-`Number()` parsing didn't reproduce.
      it("resolves an octal leading-zero override to its octal value, not decimal", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "010");
        expect(legacyEnvOverrideMajorVersion(17, testProjectEnvValues)).toBe(8);
      });

      it("resolves a 0x-prefixed override as hex", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "0x10");
        expect(legacyEnvOverrideMajorVersion(17, testProjectEnvValues)).toBe(16);
      });

      it("resolves a 0b-prefixed override as binary", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "0b101");
        expect(legacyEnvOverrideMajorVersion(17, testProjectEnvValues)).toBe(5);
      });

      it("still resolves a plain decimal override with no leading zero", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "15");
        expect(legacyEnvOverrideMajorVersion(17, testProjectEnvValues)).toBe(15);
      });

      // Underscore digit separators are only legal in Go's base-0 mode (Go 1.13+).
      it("permits an underscore digit separator between decimal digits", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "1_000");
        expect(legacyEnvOverrideMajorVersion(17, testProjectEnvValues)).toBe(1000);
      });

      // Go does NOT fall back to decimal when a bare-leading-zero literal contains an
      // invalid octal digit — `"08"`/`"09"` are rejected outright, never read as 8/9.
      it("rejects an invalid octal digit instead of silently falling back to decimal", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "08");
        expect(() => legacyEnvOverrideMajorVersion(17, testProjectEnvValues)).toThrow(
          "Failed reading config: Invalid db.major_version: 08.",
        );
      });

      // `strconv.ParseUint` never accepts a leading sign, unlike `ParseInt`.
      it("rejects a signed override", () => {
        stubEnv("SUPABASE_DB_MAJOR_VERSION", "+5");
        expect(() => legacyEnvOverrideMajorVersion(17, testProjectEnvValues)).toThrow(
          "Failed reading config: Invalid db.major_version: +5.",
        );
      });
    });

    describe("legacyEnvOverridePoolMode", () => {
      afterEach(() => {
        stubEnv("SUPABASE_DB_POOLER_POOL_MODE", undefined);
      });

      it("falls back to the configured value when unset", () => {
        expect(legacyEnvOverridePoolMode("transaction", testProjectEnvValues)).toBe("transaction");
      });

      it("overrides the configured value via the env var", () => {
        stubEnv("SUPABASE_DB_POOLER_POOL_MODE", "session");
        expect(legacyEnvOverridePoolMode("transaction", testProjectEnvValues)).toBe("session");
      });

      // `PoolMode.UnmarshalText` hard-rejects any
      // value outside `{transaction, session}`.
      it("rejects an invalid override instead of falling back to the configured value", () => {
        stubEnv("SUPABASE_DB_POOLER_POOL_MODE", "invalid");
        expect(() => legacyEnvOverridePoolMode("transaction", testProjectEnvValues)).toThrow(
          LegacyInvalidPoolModeEnvOverrideError,
        );
        expect(() => legacyEnvOverridePoolMode("transaction", testProjectEnvValues)).toThrow(
          'Invalid config for db.pooler.pool_mode: cannot parse "invalid" as one of "transaction", "session"',
        );
      });
    });

    describe("legacyEnvOverrideEdgeRuntimePolicy", () => {
      afterEach(() => {
        stubEnv("SUPABASE_EDGE_RUNTIME_POLICY", undefined);
      });

      it("falls back to the configured value when unset", () => {
        expect(legacyEnvOverrideEdgeRuntimePolicy("oneshot", testProjectEnvValues)).toBe("oneshot");
      });

      it("overrides the configured value via the env var", () => {
        stubEnv("SUPABASE_EDGE_RUNTIME_POLICY", "per_worker");
        expect(legacyEnvOverrideEdgeRuntimePolicy("oneshot", testProjectEnvValues)).toBe(
          "per_worker",
        );
      });

      // `RequestPolicy.UnmarshalText` hard-rejects
      // any value outside `{per_worker, oneshot}`.
      it("rejects an invalid override instead of falling back to the configured value", () => {
        stubEnv("SUPABASE_EDGE_RUNTIME_POLICY", "invalid");
        expect(() => legacyEnvOverrideEdgeRuntimePolicy("oneshot", testProjectEnvValues)).toThrow(
          LegacyInvalidEdgeRuntimePolicyEnvOverrideError,
        );
        expect(() => legacyEnvOverrideEdgeRuntimePolicy("oneshot", testProjectEnvValues)).toThrow(
          'Invalid config for edge_runtime.policy: cannot parse "invalid" as one of "per_worker", "oneshot"',
        );
      });
    });

    describe("legacyEnvOverrideDefaultPoolSize", () => {
      afterEach(() => {
        stubEnv("SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE", undefined);
      });

      it("falls back to the configured value when unset", () => {
        expect(legacyEnvOverrideDefaultPoolSize(20, testProjectEnvValues)).toBe(20);
      });

      it("overrides the configured value via the env var", () => {
        stubEnv("SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE", "40");
        expect(legacyEnvOverrideDefaultPoolSize(20, testProjectEnvValues)).toBe(40);
      });
    });

    describe("legacyEnvOverrideMaxClientConn", () => {
      afterEach(() => {
        stubEnv("SUPABASE_DB_POOLER_MAX_CLIENT_CONN", undefined);
      });

      it("falls back to the configured value when unset", () => {
        expect(legacyEnvOverrideMaxClientConn(100, testProjectEnvValues)).toBe(100);
      });

      it("overrides the configured value via the env var", () => {
        stubEnv("SUPABASE_DB_POOLER_MAX_CLIENT_CONN", "200");
        expect(legacyEnvOverrideMaxClientConn(100, testProjectEnvValues)).toBe(200);
      });
    });

    describe("legacyResolveAuthCaptcha", () => {
      afterEach(() => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_ENABLED", undefined);
        stubEnv("SUPABASE_AUTH_CAPTCHA_PROVIDER", undefined);
        stubEnv("SUPABASE_AUTH_CAPTCHA_SECRET", undefined);
      });

      it("returns undefined when captcha is not configured", () => {
        expect(
          legacyResolveAuthCaptcha(undefined, undefined, testProjectEnvValues),
        ).toBeUndefined();
      });

      it("overrides enabled/provider when the section is present in the document", () => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_ENABLED", "true");
        stubEnv("SUPABASE_AUTH_CAPTCHA_PROVIDER", "turnstile");
        const authDocument = { captcha: { enabled: false, provider: "hcaptcha" } };
        const resolved = legacyResolveAuthCaptcha(
          authDocument,
          { enabled: false, provider: "hcaptcha", secret: "shh" },
          testProjectEnvValues,
        );
        expect(resolved?.enabled).toBe(true);
        expect(resolved?.provider).toBe("turnstile");
      });

      it("does not apply an env override when [auth.captcha] is absent from the document", () => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_ENABLED", "true");
        const resolved = legacyResolveAuthCaptcha(
          {},
          { enabled: false, provider: "hcaptcha", secret: "shh" },
          testProjectEnvValues,
        );
        expect(resolved?.enabled).toBe(false);
      });

      it("decrypts an encrypted: captcha secret", () => {
        stubEnv(
          "DOTENV_PRIVATE_KEY",
          "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb",
        );
        const authDocument = { captcha: { enabled: true } };
        const resolved = legacyResolveAuthCaptcha(
          authDocument,
          {
            enabled: true,
            provider: "hcaptcha",
            secret:
              "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/",
          },
          testProjectEnvValues,
        );
        expect(resolved?.secret).toBe("value");
        stubEnv("DOTENV_PRIVATE_KEY", undefined);
      });

      it("suppresses a malformed SUPABASE_AUTH_CAPTCHA_ENABLED when a remote block already set auth.captcha.enabled", () => {
        // Regression (review: PRRT_kwDOErm0O86W6R-G): same "throws before a value the caller
        // needs is resolved" bug class as `studio.enabled`/`auth.enabled` above — this function's
        // own ungated `legacyEnvOverrideBool` call would abort the whole
        // `legacyResolveLocalConfigValues` caller (and the shadow it feeds) on a malformed
        // override the remote block should have made irrelevant.
        stubEnv("SUPABASE_AUTH_CAPTCHA_ENABLED", "not-a-bool");
        const authDocument = { captcha: { enabled: false } };
        expect(() =>
          legacyResolveAuthCaptcha(
            authDocument,
            { enabled: false, provider: "hcaptcha", secret: "shh" },
            testProjectEnvValues,
            new Set(["auth.captcha.enabled"]),
          ),
        ).not.toThrow();
      });

      it("still rejects a malformed SUPABASE_AUTH_CAPTCHA_ENABLED when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_ENABLED", "not-a-bool");
        const authDocument = { captcha: { enabled: false } };
        expect(() =>
          legacyResolveAuthCaptcha(
            authDocument,
            { enabled: false, provider: "hcaptcha", secret: "shh" },
            testProjectEnvValues,
          ),
        ).toThrow('cannot parse "not-a-bool" as a bool');
      });

      it("suppresses a malformed SUPABASE_AUTH_CAPTCHA_SECRET when a remote block already set auth.captcha.secret", () => {
        // Regression (review: PRRT_kwDOErm0O86XJ4HR) — same bug class as `auth.email.smtp.pass`
        // (review: PRRT_kwDOErm0O86XJYol): this function's own ungated `legacyEnvOverride` call fed
        // a malformed ambient override straight into `legacyDecryptAuthSecret`, which throws on an
        // undecryptable `encrypted:...` value — aborting the whole `legacyResolveLocalConfigValues`
        // caller (and the shadow it feeds) on an env value `v.Set` (override tier, above
        // `AutomaticEnv`) never lets reach decryption once a remote block already set the secret.
        stubEnv("SUPABASE_AUTH_CAPTCHA_SECRET", "encrypted:not-a-real-ciphertext");
        const authDocument = { captcha: { enabled: true } };
        const resolved = legacyResolveAuthCaptcha(
          authDocument,
          { enabled: true, provider: "hcaptcha", secret: "remote-secret" },
          testProjectEnvValues,
          new Set(["auth.captcha.secret"]),
        );
        expect(resolved?.secret).toBe("remote-secret");
      });

      it("still rejects a malformed SUPABASE_AUTH_CAPTCHA_SECRET when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_SECRET", "encrypted:not-a-real-ciphertext");
        const authDocument = { captcha: { enabled: true } };
        expect(() =>
          legacyResolveAuthCaptcha(
            authDocument,
            { enabled: true, provider: "hcaptcha", secret: "remote-secret" },
            testProjectEnvValues,
          ),
        ).toThrow("failed to parse config: missing private key");
      });

      it("preserves a remote block's valid auth.captcha.provider over an unsupported ambient override", () => {
        // Regression (review: PRRT_kwDOErm0O86XLAYn): `provider` can't throw on its own
        // (`legacyEnvOverride` is a plain string read), but an ungated override here still let a
        // stale/unsupported ambient `SUPABASE_AUTH_CAPTCHA_PROVIDER` outrank a matched remote's own
        // valid provider — `legacyValidateResolvedConfig`'s enum check downstream then aborts the
        // whole `legacyResolveLocalConfigValues` caller (and the shadow it feeds) on a value Go's
        // `v.Set` (override tier, above `AutomaticEnv`) never lets win.
        stubEnv("SUPABASE_AUTH_CAPTCHA_PROVIDER", "recaptcha");
        const authDocument = { captcha: { enabled: true, provider: "hcaptcha" } };
        const resolved = legacyResolveAuthCaptcha(
          authDocument,
          { enabled: true, provider: "hcaptcha", secret: "shh" },
          testProjectEnvValues,
          new Set(["auth.captcha.provider"]),
        );
        expect(resolved?.provider).toBe("hcaptcha");
      });

      it("still applies SUPABASE_AUTH_CAPTCHA_PROVIDER when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_PROVIDER", "turnstile");
        const authDocument = { captcha: { enabled: true, provider: "hcaptcha" } };
        const resolved = legacyResolveAuthCaptcha(
          authDocument,
          { enabled: true, provider: "hcaptcha", secret: "shh" },
          testProjectEnvValues,
        );
        expect(resolved?.provider).toBe("turnstile");
      });
    });

    describe("legacyResolveAuthEmail", () => {
      afterEach(() => {
        stubEnv("SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_SUBJECT", undefined);
      });

      // `emailTemplate.Subject` is `*string` — an explicit
      // `subject = ""` in config.toml is a real, non-nil state, distinct from an absent key, that
      // Go's mailer-env block honors by still emitting `GOTRUE_MAILER_SUBJECTS_*=` (empty).
      it("keeps an explicit empty subject present in the raw document, not omitted", () => {
        const config = baseConfig({
          auth: { email: { template: { confirmation: { subject: "", content_path: "x" } } } },
        });
        const authDocument = { email: { template: { confirmation: { subject: "" } } } };
        const resolved = legacyResolveAuthEmail(
          config.auth.email,
          authDocument,
          testProjectEnvValues,
        );
        expect(resolved.template["confirmation"]?.subject).toBe("");
      });

      it("omits the subject when the key is absent from the raw document", () => {
        const config = baseConfig({
          auth: { email: { template: { confirmation: { content_path: "x" } } } },
        });
        const authDocument = { email: { template: { confirmation: { content_path: "x" } } } };
        const resolved = legacyResolveAuthEmail(
          config.auth.email,
          authDocument,
          testProjectEnvValues,
        );
        expect(resolved.template["confirmation"]?.subject).toBeUndefined();
      });

      it("prefers an env-overridden subject over the raw document's presence, even when absent", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_SUBJECT", "Overridden subject");
        const config = baseConfig({
          auth: { email: { template: { confirmation: { content_path: "x" } } } },
        });
        const authDocument = { email: { template: { confirmation: { content_path: "x" } } } };
        const resolved = legacyResolveAuthEmail(
          config.auth.email,
          authDocument,
          testProjectEnvValues,
        );
        expect(resolved.template["confirmation"]?.subject).toBe("Overridden subject");
      });

      describe("max_frequency — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
        afterEach(() => {
          stubEnv("SUPABASE_AUTH_EMAIL_MAX_FREQUENCY", undefined);
        });

        it("prefers a remote-set auth.email.max_frequency over a conflicting SUPABASE_AUTH_EMAIL_MAX_FREQUENCY", () => {
          stubEnv("SUPABASE_AUTH_EMAIL_MAX_FREQUENCY", "5s");
          const config = baseConfig({ auth: { email: { max_frequency: "1m" } } });
          const resolved = legacyResolveAuthEmail(
            config.auth.email,
            testProjectEnvValues,
            undefined,
            new Set(["auth.email.max_frequency"]),
          );
          expect(resolved.max_frequency).toBe("1m");
        });

        it("still applies SUPABASE_AUTH_EMAIL_MAX_FREQUENCY when no remote block matched", () => {
          stubEnv("SUPABASE_AUTH_EMAIL_MAX_FREQUENCY", "5s");
          const config = baseConfig({ auth: { email: { max_frequency: "1m" } } });
          const resolved = legacyResolveAuthEmail(
            config.auth.email,
            undefined,
            testProjectEnvValues,
          );
          expect(resolved.max_frequency).toBe("5s");
        });
      });
    });

    describe("legacyResolveAuthHooks", () => {
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
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED", undefined);
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI", undefined);
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS", undefined);
      });

      it("leaves every hook disabled when nothing is configured or overridden", () => {
        const resolved = legacyResolveAuthHooks(undefined, allHooks, testProjectEnvValues);
        expect(resolved.customAccessToken.enabled).toBe(false);
        expect(resolved.mfaVerificationAttempt.enabled).toBe(false);
      });

      it("overrides enabled/uri when the hook's section is present in the document", () => {
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED", "true");
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI", "https://example.com/hook");
        const authDocument = { hook: { custom_access_token: { enabled: false } } };
        const resolved = legacyResolveAuthHooks(authDocument, allHooks, testProjectEnvValues);
        expect(resolved.customAccessToken.enabled).toBe(true);
        expect(resolved.customAccessToken.uri).toBe("https://example.com/hook");
        // Unrelated hooks stay untouched.
        expect(resolved.mfaVerificationAttempt.enabled).toBe(false);
      });

      it("does not apply an env override when the hook's section is absent from the document", () => {
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED", "true");
        const resolved = legacyResolveAuthHooks({}, allHooks, testProjectEnvValues);
        expect(resolved.customAccessToken.enabled).toBe(false);
      });

      it("suppresses a malformed SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED when a remote block already set that hook's enabled", () => {
        // Regression (review: PRRT_kwDOErm0O86W6R-G) — same bug class as `studio.enabled` above.
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED", "not-a-bool");
        const authDocument = { hook: { custom_access_token: { enabled: false } } };
        expect(() =>
          legacyResolveAuthHooks(
            authDocument,
            allHooks,
            testProjectEnvValues,
            new Set(["auth.hook.custom_access_token.enabled"]),
          ),
        ).not.toThrow();
      });

      it("still rejects a malformed SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED", "not-a-bool");
        const authDocument = { hook: { custom_access_token: { enabled: false } } };
        expect(() => legacyResolveAuthHooks(authDocument, allHooks, testProjectEnvValues)).toThrow(
          'cannot parse "not-a-bool" as a bool',
        );
      });

      it("prefers a remote-set auth.hook.custom_access_token.uri over a conflicting SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI", () => {
        // Regression (review: PRRT_kwDOErm0O86XGTq5) — `mergeRemoteConfig` flattens the whole
        // matched block via `u.AllKeys()` and applies EVERY leaf with `v.Set`,
        // not just `enabled`. Leaving `uri` ungated
        // let a stale/malformed env var beat a remote's already-merged, valid `uri`.
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI", "ftp://example.com");
        const hooksWithRemoteUri = {
          ...allHooks,
          custom_access_token: { enabled: true, uri: "https://example.com/hook", secrets: "" },
        };
        const authDocument = { hook: { custom_access_token: { enabled: true } } };
        const resolved = legacyResolveAuthHooks(
          authDocument,
          hooksWithRemoteUri,
          testProjectEnvValues,
          new Set(["auth.hook.custom_access_token.uri"]),
        );
        expect(resolved.customAccessToken.uri).toBe("https://example.com/hook");
      });

      it("prefers a remote-set auth.hook.custom_access_token.secrets over a conflicting SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS", () => {
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS", "env-secret");
        const hooksWithRemoteSecrets = {
          ...allHooks,
          custom_access_token: { enabled: true, uri: "", secrets: "remote-secret" },
        };
        const authDocument = { hook: { custom_access_token: { enabled: true } } };
        const resolved = legacyResolveAuthHooks(
          authDocument,
          hooksWithRemoteSecrets,
          testProjectEnvValues,
          new Set(["auth.hook.custom_access_token.secrets"]),
        );
        expect(resolved.customAccessToken.secrets).toBe("remote-secret");
      });

      it("still applies the env override for uri when no remote block matched that leaf", () => {
        stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI", "https://env.example.com/hook");
        const hooksWithLocalUri = {
          ...allHooks,
          custom_access_token: {
            enabled: true,
            uri: "https://local.example.com/hook",
            secrets: "",
          },
        };
        const authDocument = { hook: { custom_access_token: { enabled: true } } };
        const resolved = legacyResolveAuthHooks(
          authDocument,
          hooksWithLocalUri,
          testProjectEnvValues,
        );
        expect(resolved.customAccessToken.uri).toBe("https://env.example.com/hook");
      });
    });

    describe("legacyResolveAuthMfa — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
      afterEach(() => {
        stubEnv("SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED", undefined);
      });

      it("suppresses a malformed SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED when a remote block already set auth.mfa.totp.enroll_enabled", () => {
        // Regression (review: PRRT_kwDOErm0O86W6R-G) — same bug class as `studio.enabled` above:
        // every `auth.mfa.*` leaf here is unconditionally resolved by
        // `legacyResolveLocalConfigValues` (inside its `authEnabled` block), so an ungated call
        // would abort that whole caller on a malformed override the remote block should have made
        // irrelevant.
        stubEnv("SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED", "not-a-bool");
        const mfa = baseConfig().auth.mfa;
        expect(() =>
          legacyResolveAuthMfa(
            mfa,
            testProjectEnvValues,
            new Set(["auth.mfa.totp.enroll_enabled"]),
          ),
        ).not.toThrow();
      });

      it("still rejects a malformed SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED", "not-a-bool");
        const mfa = baseConfig().auth.mfa;
        expect(() => legacyResolveAuthMfa(mfa, testProjectEnvValues)).toThrow(
          'cannot parse "not-a-bool" as a bool',
        );
      });

      it("prefers a remote-set auth.mfa.phone.template over a conflicting SUPABASE_AUTH_MFA_PHONE_TEMPLATE", () => {
        stubEnv("SUPABASE_AUTH_MFA_PHONE_TEMPLATE", "env template");
        const mfa = {
          ...baseConfig().auth.mfa,
          phone: { ...baseConfig().auth.mfa.phone, template: "remote template" },
        };
        const resolved = legacyResolveAuthMfa(
          mfa,
          testProjectEnvValues,
          new Set(["auth.mfa.phone.template"]),
        );
        expect(resolved.phone.template).toBe("remote template");
        stubEnv("SUPABASE_AUTH_MFA_PHONE_TEMPLATE", undefined);
      });

      it("still applies SUPABASE_AUTH_MFA_PHONE_TEMPLATE when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_MFA_PHONE_TEMPLATE", "env template");
        const mfa = {
          ...baseConfig().auth.mfa,
          phone: { ...baseConfig().auth.mfa.phone, template: "remote template" },
        };
        const resolved = legacyResolveAuthMfa(mfa, testProjectEnvValues);
        expect(resolved.phone.template).toBe("env template");
        stubEnv("SUPABASE_AUTH_MFA_PHONE_TEMPLATE", undefined);
      });

      it("prefers a remote-set auth.mfa.phone.max_frequency over a conflicting SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY", () => {
        stubEnv("SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY", "5s");
        const mfa = {
          ...baseConfig().auth.mfa,
          phone: { ...baseConfig().auth.mfa.phone, max_frequency: "1m" },
        };
        const resolved = legacyResolveAuthMfa(
          mfa,
          testProjectEnvValues,
          new Set(["auth.mfa.phone.max_frequency"]),
        );
        expect(resolved.phone.max_frequency).toBe("1m");
        stubEnv("SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY", undefined);
      });

      it("still applies SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY", "5s");
        const mfa = {
          ...baseConfig().auth.mfa,
          phone: { ...baseConfig().auth.mfa.phone, max_frequency: "1m" },
        };
        const resolved = legacyResolveAuthMfa(mfa, testProjectEnvValues);
        expect(resolved.phone.max_frequency).toBe("5s");
        stubEnv("SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY", undefined);
      });
    });

    describe("legacyResolveAuthEmailSmtp — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
      afterEach(() => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ENABLED", undefined);
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_PASS", undefined);
      });

      it("suppresses a malformed SUPABASE_AUTH_EMAIL_SMTP_ENABLED when a remote block already set auth.email.smtp.enabled", () => {
        // Regression (review: PRRT_kwDOErm0O86W6R-G) — same bug class as `studio.enabled` above.
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ENABLED", "not-a-bool");
        const authDocument = { email: { smtp: { enabled: true } } };
        expect(() =>
          legacyResolveAuthEmailSmtp(
            authDocument,
            testProjectEnvValues,
            new Set(["auth.email.smtp.enabled"]),
          ),
        ).not.toThrow();
      });

      it("still rejects a malformed SUPABASE_AUTH_EMAIL_SMTP_ENABLED when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ENABLED", "not-a-bool");
        const authDocument = { email: { smtp: { enabled: true } } };
        expect(() => legacyResolveAuthEmailSmtp(authDocument, testProjectEnvValues)).toThrow(
          'cannot parse "not-a-bool" as a bool',
        );
      });

      it("suppresses a malformed SUPABASE_AUTH_EMAIL_SMTP_PASS when a remote block already set auth.email.smtp.pass", () => {
        // Regression (review: PRRT_kwDOErm0O86XJYol) — same bug class as `.enabled`/`.port`
        // above, just for this Secret-typed leaf: an ungated env override reached
        // `legacyDecryptAuthSecret` and threw before the remote's own valid `pass` was used.
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_PASS", "encrypted:not-a-real-ciphertext");
        const authDocument = { email: { smtp: { enabled: true, pass: "remote-pass" } } };
        const resolved = legacyResolveAuthEmailSmtp(
          authDocument,
          testProjectEnvValues,
          new Set(["auth.email.smtp.pass"]),
        );
        expect(resolved?.pass).toBe("remote-pass");
      });

      it("still rejects a malformed SUPABASE_AUTH_EMAIL_SMTP_PASS when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_PASS", "encrypted:not-a-real-ciphertext");
        const authDocument = { email: { smtp: { enabled: true, pass: "remote-pass" } } };
        expect(() => legacyResolveAuthEmailSmtp(authDocument, testProjectEnvValues)).toThrow(
          "failed to parse config: missing private key",
        );
      });

      it("prefers a remote-set auth.email.smtp.host over a conflicting SUPABASE_AUTH_EMAIL_SMTP_HOST", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_HOST", "smtp.env.example.com");
        const authDocument = {
          email: { smtp: { enabled: true, host: "smtp.remote.example.com" } },
        };
        const resolved = legacyResolveAuthEmailSmtp(
          authDocument,
          testProjectEnvValues,
          new Set(["auth.email.smtp.host"]),
        );
        expect(resolved?.host).toBe("smtp.remote.example.com");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_HOST", undefined);
      });

      it("still applies SUPABASE_AUTH_EMAIL_SMTP_HOST when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_HOST", "smtp.env.example.com");
        const authDocument = {
          email: { smtp: { enabled: true, host: "smtp.remote.example.com" } },
        };
        const resolved = legacyResolveAuthEmailSmtp(authDocument, testProjectEnvValues);
        expect(resolved?.host).toBe("smtp.env.example.com");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_HOST", undefined);
      });

      it("prefers a remote-set auth.email.smtp.user over a conflicting SUPABASE_AUTH_EMAIL_SMTP_USER", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_USER", "env-user");
        const authDocument = { email: { smtp: { enabled: true, user: "remote-user" } } };
        const resolved = legacyResolveAuthEmailSmtp(
          authDocument,
          testProjectEnvValues,
          new Set(["auth.email.smtp.user"]),
        );
        expect(resolved?.user).toBe("remote-user");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_USER", undefined);
      });

      it("still applies SUPABASE_AUTH_EMAIL_SMTP_USER when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_USER", "env-user");
        const authDocument = { email: { smtp: { enabled: true, user: "remote-user" } } };
        const resolved = legacyResolveAuthEmailSmtp(authDocument, testProjectEnvValues);
        expect(resolved?.user).toBe("env-user");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_USER", undefined);
      });

      it("prefers a remote-set auth.email.smtp.admin_email over a conflicting SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL", "env@example.com");
        const authDocument = {
          email: { smtp: { enabled: true, admin_email: "remote@example.com" } },
        };
        const resolved = legacyResolveAuthEmailSmtp(
          authDocument,
          testProjectEnvValues,
          new Set(["auth.email.smtp.admin_email"]),
        );
        expect(resolved?.adminEmail).toBe("remote@example.com");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL", undefined);
      });

      it("still applies SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL", "env@example.com");
        const authDocument = {
          email: { smtp: { enabled: true, admin_email: "remote@example.com" } },
        };
        const resolved = legacyResolveAuthEmailSmtp(authDocument, testProjectEnvValues);
        expect(resolved?.adminEmail).toBe("env@example.com");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL", undefined);
      });

      it("prefers a remote-set auth.email.smtp.sender_name over a conflicting SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME", "Env Sender");
        const authDocument = { email: { smtp: { enabled: true, sender_name: "Remote Sender" } } };
        const resolved = legacyResolveAuthEmailSmtp(
          authDocument,
          testProjectEnvValues,
          new Set(["auth.email.smtp.sender_name"]),
        );
        expect(resolved?.senderName).toBe("Remote Sender");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME", undefined);
      });

      it("still applies SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME when no remote block matched", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME", "Env Sender");
        const authDocument = { email: { smtp: { enabled: true, sender_name: "Remote Sender" } } };
        const resolved = legacyResolveAuthEmailSmtp(authDocument, testProjectEnvValues);
        expect(resolved?.senderName).toBe("Env Sender");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME", undefined);
      });
    });

    describe("legacyResolveAuthExternalProviders", () => {
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
        const resolved = legacyResolveAuthExternalProviders(
          authDocument,
          baseConfig().auth.external,
          testProjectEnvValues,
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
          legacyResolveAuthExternalProviders(
            authDocument,
            baseConfig().auth.external,
            testProjectEnvValues,
          ),
        ).toThrow('cannot parse "not-a-bool" as a bool');
      });

      it("leaves an absent custom-provider boolean field at its schema default without throwing", () => {
        const authDocument = {
          external: { my_custom: { client_id: "custom-client-id" } },
        };
        const resolved = legacyResolveAuthExternalProviders(
          authDocument,
          baseConfig().auth.external,
          testProjectEnvValues,
        );
        expect(resolved["my_custom"]?.enabled).toBe(false);
      });

      it("weakly coerces a raw numeric custom-provider boolean by truthiness, matching Go's WeaklyTypedInput decode", () => {
        const authDocument = {
          external: { my_custom: { enabled: 1, client_id: "custom-client-id" } },
        };
        const resolved = legacyResolveAuthExternalProviders(
          authDocument,
          baseConfig().auth.external,
          testProjectEnvValues,
        );
        expect(resolved["my_custom"]?.enabled).toBe(true);
      });

      it("throws on a raw array/table custom-provider boolean instead of silently disabling it", () => {
        const authDocument = {
          external: { my_custom: { enabled: [1, 2], client_id: "custom-client-id" } },
        };
        expect(() =>
          legacyResolveAuthExternalProviders(
            authDocument,
            baseConfig().auth.external,
            testProjectEnvValues,
          ),
        ).toThrow('cannot parse "1,2" as a bool');
      });

      it("resolves apple purely from env overrides even with no config.toml [auth.external] section at all, matching Go's ejected default template", () => {
        const projectEnvValues = {
          SUPABASE_AUTH_EXTERNAL_APPLE_ENABLED: "true",
          SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID: "apple-client-id",
          SUPABASE_AUTH_EXTERNAL_APPLE_SECRET: "apple-secret",
          SUPABASE_AUTH_EXTERNAL_APPLE_URL: "https://appleid.apple.com",
        };
        const resolved = legacyResolveAuthExternalProviders(
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
        const resolved = legacyResolveAuthExternalProviders(
          undefined,
          baseConfig().auth.external,
          projectEnvValues,
        );
        expect(resolved["google"]).toBeUndefined();
        // apple is still unconditionally present (Go's default template), but unaffected by
        // the unrelated google env vars above.
        expect(resolved["apple"]?.enabled).toBe(false);
      });
    });

    describe("legacyResolveAuthExternalProviders — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
      // Regression (review: PRRT_kwDOErm0O86XKYiF): this resolver had no `remoteOverrideKeys`
      // parameter at all, so a matched `[remotes.<ref>]` block's own valid `auth.external.<name>.*`
      // value could always lose to a conflicting/malformed ambient `SUPABASE_AUTH_EXTERNAL_<NAME>_*`
      // override — `secret`/`enabled`/`skip_nonce_check`/`email_optional` can additionally THROW on
      // a malformed override, aborting the whole `legacyResolveLocalConfigValues` caller (and the
      // shadow it feeds).
      it("prefers a remote-set auth.external.<name>.secret over a malformed SUPABASE_AUTH_EXTERNAL_<NAME>_SECRET", () => {
        const authDocument = {
          external: { my_custom: { enabled: true, secret: "remote-secret" } },
        };
        const projectEnvValues = { SUPABASE_AUTH_EXTERNAL_MY_CUSTOM_SECRET: "encrypted:garbage" };
        const resolved = legacyResolveAuthExternalProviders(
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
          legacyResolveAuthExternalProviders(
            authDocument,
            baseConfig().auth.external,
            projectEnvValues,
          ),
        ).toThrow("failed to parse config: missing private key");
      });

      it("prefers a remote-set auth.external.<name>.enabled over a malformed SUPABASE_AUTH_EXTERNAL_<NAME>_ENABLED", () => {
        const authDocument = { external: { my_custom: { enabled: true } } };
        const projectEnvValues = { SUPABASE_AUTH_EXTERNAL_MY_CUSTOM_ENABLED: "not-a-bool" };
        expect(() =>
          legacyResolveAuthExternalProviders(
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
          legacyResolveAuthExternalProviders(
            authDocument,
            baseConfig().auth.external,
            projectEnvValues,
          ),
        ).toThrow('cannot parse "not-a-bool" as a bool');
      });

      it("prefers a remote-set auth.external.<name>.client_id over a conflicting SUPABASE_AUTH_EXTERNAL_<NAME>_CLIENT_ID", () => {
        const authDocument = {
          external: { my_custom: { enabled: true, client_id: "remote-client-id" } },
        };
        const projectEnvValues = {
          SUPABASE_AUTH_EXTERNAL_MY_CUSTOM_CLIENT_ID: "env-should-not-win",
        };
        const resolved = legacyResolveAuthExternalProviders(
          authDocument,
          baseConfig().auth.external,
          projectEnvValues,
          new Set(["auth.external.my_custom.client_id"]),
        );
        expect(resolved["my_custom"]?.clientId).toBe("remote-client-id");
      });
    });

    describe("legacyRawUnmodeledBool", () => {
      it("returns false for an absent value, matching Go's zero-value bool default", () => {
        expect(legacyRawUnmodeledBool(undefined, "auth.passkey.enabled")).toBe(false);
      });

      it("passes a real boolean through unchanged", () => {
        expect(legacyRawUnmodeledBool(true, "auth.passkey.enabled")).toBe(true);
        expect(legacyRawUnmodeledBool(false, "auth.passkey.enabled")).toBe(false);
      });

      it("weakly coerces a raw number by truthiness, matching mapstructure's WeaklyTypedInput decodeBool", () => {
        expect(legacyRawUnmodeledBool(123, "auth.passkey.enabled")).toBe(true);
        expect(legacyRawUnmodeledBool(0, "auth.passkey.enabled")).toBe(false);
        expect(legacyRawUnmodeledBool(1.5, "auth.passkey.enabled")).toBe(true);
      });

      it("parses a valid boolean-ish string the way Go's strconv.ParseBool does", () => {
        expect(legacyRawUnmodeledBool("true", "auth.passkey.enabled")).toBe(true);
        expect(legacyRawUnmodeledBool("False", "auth.passkey.enabled")).toBe(false);
        expect(legacyRawUnmodeledBool("", "auth.passkey.enabled")).toBe(false);
      });

      it("throws on an unparsable string instead of silently disabling it", () => {
        expect(() => legacyRawUnmodeledBool("not-a-bool", "auth.passkey.enabled")).toThrow(
          'cannot parse "not-a-bool" as a bool',
        );
      });

      it("throws on an array or table value — mapstructure's decodeBool errors on these unconditionally, never weakly coerced", () => {
        expect(() => legacyRawUnmodeledBool([1, 2], "auth.passkey.enabled")).toThrow(
          LegacyInvalidBoolEnvOverrideError,
        );
        expect(() => legacyRawUnmodeledBool({ nested: true }, "auth.passkey.enabled")).toThrow(
          LegacyInvalidBoolEnvOverrideError,
        );
      });
    });

    describe("legacyResolveDbSettingsEnvOverrides", () => {
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
        for (const name of ALL_OVERRIDE_NAMES) stubEnv(name, undefined);
      });

      it("returns the configured settings unchanged when nothing is overridden", () => {
        const settings = { shared_buffers: "128MB", max_connections: 100 };
        expect(legacyResolveDbSettingsEnvOverrides(settings, testProjectEnvValues)).toEqual(
          settings,
        );
      });

      it("leaves an unconfigured field undefined when nothing is overridden", () => {
        expect(
          legacyResolveDbSettingsEnvOverrides({}, testProjectEnvValues).effective_cache_size,
        ).toBeUndefined();
      });

      it("overrides a string field via the env var", () => {
        stubEnv("SUPABASE_DB_SETTINGS_SHARED_BUFFERS", "256MB");
        expect(
          legacyResolveDbSettingsEnvOverrides({ shared_buffers: "128MB" }, testProjectEnvValues)
            .shared_buffers,
        ).toBe("256MB");
      });

      it("sets a string field via the env var even when not configured at all", () => {
        stubEnv("SUPABASE_DB_SETTINGS_WORK_MEM", "8MB");
        expect(legacyResolveDbSettingsEnvOverrides({}, testProjectEnvValues).work_mem).toBe("8MB");
      });

      it("overrides a uint field via the env var", () => {
        stubEnv("SUPABASE_DB_SETTINGS_MAX_CONNECTIONS", "200");
        expect(
          legacyResolveDbSettingsEnvOverrides({ max_connections: 100 }, testProjectEnvValues)
            .max_connections,
        ).toBe(200);
      });

      it("rejects a non-numeric uint override", () => {
        stubEnv("SUPABASE_DB_SETTINGS_MAX_CONNECTIONS", "not-a-number");
        expect(() => legacyResolveDbSettingsEnvOverrides({}, testProjectEnvValues)).toThrow(
          "Invalid db.settings.max_connections",
        );
      });

      // `db.settings.*` uint fields decode through the same `strconv.ParseUint(str, 0, 64)`
      // base-0 grammar as `legacyEnvOverrideUint`'s callers, not a plain-decimal parse.
      it("resolves a 0x-prefixed uint override as hex", () => {
        stubEnv("SUPABASE_DB_SETTINGS_MAX_CONNECTIONS", "0x10");
        expect(
          legacyResolveDbSettingsEnvOverrides({ max_connections: 100 }, testProjectEnvValues)
            .max_connections,
        ).toBe(16);
      });

      it("rejects a uint override exceeding the uint64 max (2^64), matching Go's ParseUint failure", () => {
        stubEnv("SUPABASE_DB_SETTINGS_MAX_CONNECTIONS", "18446744073709551616");
        expect(() => legacyResolveDbSettingsEnvOverrides({}, testProjectEnvValues)).toThrow(
          "Failed reading config: Invalid db.settings.max_connections: 18446744073709551616.",
        );
      });

      it("overrides the boolean field via the env var", () => {
        stubEnv("SUPABASE_DB_SETTINGS_TRACK_COMMIT_TIMESTAMP", "true");
        expect(
          legacyResolveDbSettingsEnvOverrides(
            { track_commit_timestamp: false },
            testProjectEnvValues,
          ).track_commit_timestamp,
        ).toBe(true);
      });

      it("rejects a malformed boolean override", () => {
        stubEnv("SUPABASE_DB_SETTINGS_TRACK_COMMIT_TIMESTAMP", "not-a-bool");
        expect(() => legacyResolveDbSettingsEnvOverrides({}, testProjectEnvValues)).toThrow(
          LegacyInvalidBoolEnvOverrideError,
        );
      });

      it("overrides the session_replication_role enum field via the env var", () => {
        stubEnv("SUPABASE_DB_SETTINGS_SESSION_REPLICATION_ROLE", "replica");
        expect(
          legacyResolveDbSettingsEnvOverrides(
            { session_replication_role: "origin" },
            testProjectEnvValues,
          ).session_replication_role,
        ).toBe("replica");
      });

      it("leaves session_replication_role undefined when neither configured nor overridden", () => {
        expect(
          legacyResolveDbSettingsEnvOverrides({}, testProjectEnvValues).session_replication_role,
        ).toBeUndefined();
      });

      // `SessionReplicationRole.UnmarshalText`
      // hard-rejects anything outside `{origin, replica, local}`.
      it("rejects an invalid session_replication_role override", () => {
        stubEnv("SUPABASE_DB_SETTINGS_SESSION_REPLICATION_ROLE", "invalid");
        expect(() => legacyResolveDbSettingsEnvOverrides({}, testProjectEnvValues)).toThrow(
          LegacyInvalidSessionReplicationRoleEnvOverrideError,
        );
        expect(() => legacyResolveDbSettingsEnvOverrides({}, testProjectEnvValues)).toThrow(
          'Invalid config for db.settings.session_replication_role: cannot parse "invalid" as one of "origin", "replica", "local"',
        );
      });

      it("also honors a projectEnvValues (dotenv) value", () => {
        expect(
          legacyResolveDbSettingsEnvOverrides({}, { SUPABASE_DB_SETTINGS_SHARED_BUFFERS: "512MB" })
            .shared_buffers,
        ).toBe("512MB");
      });
    });

    describe("auth.signing_keys_path (asymmetric JWT signing)", () => {
      const tempRoot = useLegacyTempWorkdir("supabase-signing-keys-test-");

      it.effect("signs anon/service_role with the first RS256 key in the file", () =>
        Effect.gen(function* () {
          const jwk = generateRsaJwk();
          yield* writeSigningKeys(tempRoot.current, [jwk]);
          const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
          const values = yield* resolveLocalConfigValuesEffect(
            config,
            "127.0.0.1",
            tempRoot.current,
          );

          const publicJwk = { ...jwk, d: undefined, p: undefined, q: undefined, dp: undefined };
          const publicKey = yield* tryPromiseEffect(() => importJWK(publicJwk, "RS256"));
          const { payload, protectedHeader } = yield* tryPromiseEffect(() =>
            jwtVerify(values.anonKey, publicKey),
          );
          expect(payload).toMatchObject({ iss: "supabase-demo", role: "anon" });
          expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "test-rsa-kid" });

          const serviceRole = yield* tryPromiseEffect(() =>
            jwtVerify(values.serviceRoleKey, publicKey),
          );
          expect(serviceRole.payload).toMatchObject({ role: "service_role" });
        }),
      );

      it.effect("resolves a relative signing_keys_path against <workdir>/supabase", () =>
        Effect.gen(function* () {
          const jwk = generateRsaJwk();
          yield* writeSigningKeys(tempRoot.current, [jwk]);
          const config = baseConfig({ auth: { signing_keys_path: "./signing_keys.json" } });
          const values = yield* resolveLocalConfigValuesEffect(
            config,
            "127.0.0.1",
            tempRoot.current,
          );
          expect(values.anonKey.split(".")).toHaveLength(3);
        }),
      );

      it.effect("uses an absolute signing_keys_path as-is, without joining the workdir", () =>
        Effect.gen(function* () {
          const jwk = generateRsaJwk();
          yield* writeSigningKeys(tempRoot.current, [jwk]);
          const absolutePath = join(tempRoot.current, "supabase", "signing_keys.json");
          const config = baseConfig({ auth: { signing_keys_path: absolutePath } });
          const values = yield* resolveLocalConfigValuesEffect(
            config,
            "127.0.0.1",
            "/some/unrelated/workdir",
          );
          expect(values.anonKey.split(".")).toHaveLength(3);
        }),
      );

      it.effect("still prefers an explicit anon_key/service_role_key over signing keys", () =>
        Effect.gen(function* () {
          yield* writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
          const config = baseConfig({
            auth: {
              signing_keys_path: "signing_keys.json",
              anon_key: "configured-anon",
              service_role_key: "configured-service-role",
            },
          });
          const values = yield* resolveLocalConfigValuesEffect(
            config,
            "127.0.0.1",
            tempRoot.current,
          );
          expect(values.anonKey).toBe("configured-anon");
          expect(values.serviceRoleKey).toBe("configured-service-role");
        }),
      );

      it.effect(
        "falls back to HMAC signing when signing_keys_path resolves to an empty array",
        () =>
          Effect.gen(function* () {
            yield* writeSigningKeys(tempRoot.current, []);
            const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
            const values = yield* resolveLocalConfigValuesEffect(
              config,
              "127.0.0.1",
              tempRoot.current,
            );
            const [, payload] = values.anonKey.split(".");
            expect(decodeJson(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject({
              iss: "supabase-demo",
            });
          }),
      );

      it.effect("throws a Go-worded error when the signing keys file does not exist", () =>
        Effect.gen(function* () {
          const config = baseConfig({ auth: { signing_keys_path: "missing.json" } });
          const exit = yield* Effect.exit(
            resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(String(exit.cause)).toContain("failed to read signing keys: ");
        }),
      );

      it.effect("preserves the filesystem error when the signing keys path is a directory", () =>
        Effect.gen(function* () {
          const signingKeysPath = join(tempRoot.current, "supabase", "signing_keys.json");
          yield* makeDirectoryEffect(signingKeysPath);
          const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
          const exit = yield* Effect.exit(
            resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("EISDIR");
        }),
      );

      it.effect("throws a Go-worded error when the signing keys file is malformed JSON", () =>
        Effect.gen(function* () {
          const supabaseDir = join(tempRoot.current, "supabase");
          yield* makeDirectoryEffect(supabaseDir);
          yield* writeFileEffect(join(supabaseDir, "signing_keys.json"), "not valid json");
          const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
          const exit = yield* Effect.exit(
            resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(String(exit.cause)).toContain("failed to decode signing keys: ");
        }),
      );

      it.effect("throws when the first key uses an unsupported algorithm", () =>
        Effect.gen(function* () {
          yield* writeSigningKeys(tempRoot.current, [{ ...generateRsaJwk(), alg: "RS512" }]);
          const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
          const exit = yield* Effect.exit(
            resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(String(exit.cause)).toContain("unsupported algorithm: RS512");
        }),
      );

      // `Validate` only opens/parses `signing_keys_path` inside
      // `if c.Auth.Enabled` — a disabled
      // auth section never touches the file, however stale or missing it is.
      it.effect("skips reading a missing signing_keys_path when auth is disabled", () =>
        Effect.gen(function* () {
          const config = baseConfig({
            auth: { enabled: false, signing_keys_path: "missing.json" },
          });
          yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
        }),
      );

      it.effect(
        "skips reading a malformed signing_keys_path when auth is disabled, but still signs asymmetrically with the default key",
        () =>
          Effect.gen(function* () {
            const supabaseDir = join(tempRoot.current, "supabase");
            yield* makeDirectoryEffect(supabaseDir);
            yield* writeFileEffect(join(supabaseDir, "signing_keys.json"), "not valid json");
            const config = baseConfig({
              auth: { enabled: false, signing_keys_path: "signing_keys.json" },
            });
            const values = yield* resolveLocalConfigValuesEffect(
              config,
              "127.0.0.1",
              tempRoot.current,
            );
            // Go's `generateJWT` checks `len(a.SigningKeysPath) > 0 &&
            // len(a.SigningKeys) > 0`, NOT `auth.enabled` — `a.SigningKeys` is never empty (it keeps
            // its `NewConfig()`-seeded default when the file read is skipped), so a disabled-auth
            // config with a configured path still signs with the default ES256 key, not HMAC.
            const publicKey = yield* tryPromiseEffect(() =>
              importJWK(
                { ...LEGACY_DEFAULT_SIGNING_KEY, d: undefined, key_ops: undefined },
                "ES256",
              ),
            );
            const { payload, protectedHeader } = yield* tryPromiseEffect(() =>
              jwtVerify(values.anonKey, publicKey),
            );
            expect(payload).toMatchObject({ iss: "supabase-demo", role: "anon" });
            expect(protectedHeader).toMatchObject({
              alg: "ES256",
              kid: LEGACY_DEFAULT_SIGNING_KEY.kid,
            });
          }),
      );

      describe("SUPABASE_AUTH_ENABLED env override", () => {
        // `c.Auth.Enabled` is Viper-bound like any other field,
        // so `Validate`'s `if c.Auth.Enabled` gate
        // reads the POST-override value, not raw
        // TOML — a stale/missing signing_keys_path must be skipped when auth is
        // disabled only via env/dotenv, and read when auth is enabled only via
        // env/dotenv despite TOML saying otherwise.
        afterEach(() => {
          stubEnv("SUPABASE_AUTH_ENABLED", undefined);
        });

        it("skips reading a missing signing_keys_path when auth is disabled only via env", () => {
          stubEnv("SUPABASE_AUTH_ENABLED", "false");
          const config = baseConfig({
            auth: { enabled: true, signing_keys_path: "missing.json" },
          });
          expect(() =>
            resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current),
          ).not.toThrow();
        });

        it.effect(
          "reads signing_keys_path when auth is enabled only via env despite TOML saying disabled",
          () =>
            Effect.gen(function* () {
              stubEnv("SUPABASE_AUTH_ENABLED", "true");
              const jwk = generateRsaJwk();
              yield* writeSigningKeys(tempRoot.current, [jwk]);
              const config = baseConfig({
                auth: { enabled: false, signing_keys_path: "signing_keys.json" },
              });
              const values = yield* resolveLocalConfigValuesEffect(
                config,
                "127.0.0.1",
                tempRoot.current,
              );
              expect(values.anonKey.split(".")).toHaveLength(3);
            }),
        );

        it("rejects a malformed override instead of falling back to the configured value", () => {
          stubEnv("SUPABASE_AUTH_ENABLED", "not-a-bool");
          const config = baseConfig({
            auth: { enabled: false, signing_keys_path: "missing.json" },
          });
          expect(() => resolveLocalConfigValues(config, "127.0.0.1", tempRoot.current)).toThrow(
            'Invalid config for auth.enabled: cannot parse "not-a-bool" as a bool',
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
          stubEnv("SUPABASE_AUTH_ENABLED", undefined);
          stubEnv("SUPABASE_AUTH_SITE_URL", undefined);
        });

        it("rejects an empty site_url when auth is enabled only via env", () => {
          stubEnv("SUPABASE_AUTH_ENABLED", "true");
          const config = baseConfig({ auth: { enabled: false, site_url: "" } });
          expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
            "Missing required field in config: auth.site_url",
          );
        });

        it("does not throw when auth is disabled only via env, however empty site_url is", () => {
          stubEnv("SUPABASE_AUTH_ENABLED", "false");
          const config = baseConfig({ auth: { enabled: true, site_url: "" } });
          expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
        });

        it("accepts an env-provided site_url overriding an empty config.toml value", () => {
          stubEnv("SUPABASE_AUTH_SITE_URL", "http://localhost:4000");
          const config = baseConfig({ auth: { enabled: true, site_url: "" } });
          expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
        });

        it("exposes the overridden site_url on the returned values, not just for validation", () => {
          stubEnv("SUPABASE_AUTH_SITE_URL", "http://localhost:4000");
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
        for (const key of AUTH_SCALAR_ENV_KEYS) stubEnv(key, undefined);
      });

      it("overrides every flat auth.* scalar GoTrue needs, not just the ones Validate checks", () => {
        stubEnv("SUPABASE_AUTH_JWT_ISSUER", "https://issuer.example.com");
        stubEnv("SUPABASE_AUTH_JWT_EXPIRY", "7200");
        stubEnv(
          "SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS",
          "https://a.example.com,https://b.example.com",
        );
        stubEnv("SUPABASE_AUTH_ENABLE_SIGNUP", "false");
        stubEnv("SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS", "true");
        stubEnv("SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION", "false");
        stubEnv("SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL", "20");
        stubEnv("SUPABASE_AUTH_ENABLE_MANUAL_LINKING", "true");
        stubEnv("SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH", "12");
        stubEnv("SUPABASE_AUTH_PASSWORD_REQUIREMENTS", "lower_upper_letters_digits");

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
        stubEnv("SUPABASE_AUTH_PASSWORD_REQUIREMENTS", "bogus");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Invalid auth.password_requirements: bogus",
        );
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
      // present in config.toml (`ExperimentalBindStruct`/`AutomaticEnv`).
      afterEach(() => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_ENABLED", undefined);
        stubEnv("SUPABASE_AUTH_CAPTCHA_PROVIDER", undefined);
        stubEnv("SUPABASE_AUTH_CAPTCHA_SECRET", undefined);
      });

      it("rejects a captcha section enabled only via env with no provider", () => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_ENABLED", "true");
        const config = baseConfig({ auth: { captcha: { enabled: false } } });
        const document = { auth: { captcha: { enabled: false } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).toThrow("Missing required field in config: auth.captcha.provider");
      });

      it("does not throw when an incomplete enabled captcha section is disabled only via env", () => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_ENABLED", "false");
        const config = baseConfig({ auth: { captcha: { enabled: true } } });
        const document = { auth: { captcha: { enabled: true } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).not.toThrow();
      });

      it("accepts env-provided provider/secret overriding an enabled captcha section", () => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_PROVIDER", "hcaptcha");
        stubEnv("SUPABASE_AUTH_CAPTCHA_SECRET", "shh");
        const config = baseConfig({ auth: { captcha: { enabled: true } } });
        const document = { auth: { captcha: { enabled: true } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).not.toThrow();
      });

      it("does not synthesize a captcha section purely from an env override when [auth.captcha] is absent", () => {
        stubEnv("SUPABASE_AUTH_CAPTCHA_ENABLED", "true");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });
    });

    describe("auth.passkey / auth.webauthn env overrides", () => {
      // `auth.passkey.enabled`/`auth.webauthn.*` are Viper-bound like any other nested field once
      // `[auth.passkey]`/`[auth.webauthn]` are present in config.toml. Both are read from the raw
      // `document` (5th param), same as the presence-based defaulting above, so these tests thread
      // a `document` object through explicitly instead of relying on `baseConfig`'s decoded schema
      // (which has no `passkey`/`webauthn` fields at all).
      afterEach(() => {
        stubEnv("SUPABASE_AUTH_PASSKEY_ENABLED", undefined);
        stubEnv("SUPABASE_AUTH_WEBAUTHN_RP_ID", undefined);
        stubEnv("SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS", undefined);
      });

      it("rejects a passkey section enabled only via env with no [auth.webauthn] section", () => {
        stubEnv("SUPABASE_AUTH_PASSKEY_ENABLED", "true");
        const config = baseConfig();
        const document = { auth: { passkey: { enabled: false } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).toThrow(
          "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
        );
      });

      it("accepts env-provided rp_id/rp_origins overriding an incomplete [auth.webauthn] section", () => {
        stubEnv("SUPABASE_AUTH_PASSKEY_ENABLED", "true");
        stubEnv("SUPABASE_AUTH_WEBAUTHN_RP_ID", "localhost");
        stubEnv("SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS", "http://localhost:3000,http://localhost:3001");
        const config = baseConfig();
        const document = { auth: { passkey: { enabled: false }, webauthn: {} } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).not.toThrow();
      });

      it("does not synthesize a passkey section purely from an env override when [auth.passkey] is absent from the document", () => {
        stubEnv("SUPABASE_AUTH_PASSKEY_ENABLED", "true");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      it("throws on an unparsable raw auth.passkey.enabled string instead of silently disabling it", () => {
        // e.g. a still-literal `env(VAR)` placeholder when the referenced var was never set, or a
        // typo — Go's `strconv.ParseBool` hard-rejects this during `Config.Load`, it never silently
        // treats it as `false`.
        const config = baseConfig();
        const document = { auth: { passkey: { enabled: "not-a-bool" } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).toThrow('cannot parse "not-a-bool" as a bool');
      });
    });

    describe("auth.hook.* env overrides", () => {
      // `auth.hook.<type>.*` is Viper-bound like any other nested field once `[auth.hook.<type>]`
      // is present in config.toml. `@supabase/config`'s hook schema always decodes a default
      // `{ enabled: false }` regardless of file presence, so — like passkey/webauthn above — the
      // presence gate is read from the raw `document`, not the decoded `config`.
      afterEach(() => {
        stubEnv("SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED", undefined);
        stubEnv("SUPABASE_AUTH_HOOK_SEND_EMAIL_URI", undefined);
        stubEnv("SUPABASE_AUTH_HOOK_SEND_EMAIL_SECRETS", undefined);
      });

      it("rejects a hook section enabled only via env with no uri", () => {
        stubEnv("SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED", "true");
        const config = baseConfig();
        const document = { auth: { hook: { send_email: { enabled: false } } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).toThrow("Missing required field in config: auth.hook.send_email.uri");
      });

      it("accepts an env-provided uri overriding a TOML-enabled hook missing its uri", () => {
        stubEnv("SUPABASE_AUTH_HOOK_SEND_EMAIL_URI", "pg-functions://postgres/auth/hook");
        const config = baseConfig({ auth: { hook: { send_email: { enabled: true } } } });
        const document = { auth: { hook: { send_email: { enabled: true } } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).not.toThrow();
      });

      it("does not synthesize a hook enablement purely from an env override when the section is absent from the document", () => {
        stubEnv("SUPABASE_AUTH_HOOK_SEND_EMAIL_ENABLED", "true");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });
    });

    describe("auth.email.smtp env overrides", () => {
      // `auth.email.smtp.*` is Viper-bound like any other nested field once `[auth.email.smtp]`
      // is present in config.toml — layered on top of the presence-aware raw-document read that
      // already exists here for Go's presence-based `enabled` default.
      afterEach(() => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ENABLED", undefined);
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_HOST", undefined);
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_PORT", undefined);
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_USER", undefined);
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_PASS", undefined);
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL", undefined);
      });

      it("rejects an smtp section enabled only via env with no host", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ENABLED", "true");
        const config = baseConfig();
        const document = { auth: { email: { smtp: { enabled: false } } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).toThrow("Missing required field in config: auth.email.smtp.host");
      });

      it("accepts env-provided host/port/user/pass/admin_email overriding an enabled-but-incomplete smtp section", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_HOST", "smtp.example.com");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_PORT", "587");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_USER", "user");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_PASS", "pass");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL", "admin@example.com");
        const config = baseConfig();
        const document = { auth: { email: { smtp: { enabled: true } } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).not.toThrow();
      });

      it("rejects an invalid SUPABASE_AUTH_EMAIL_SMTP_PORT override", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_HOST", "smtp.example.com");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_PORT", "not-a-port");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_USER", "user");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_PASS", "pass");
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL", "admin@example.com");
        const config = baseConfig();
        const document = { auth: { email: { smtp: { enabled: true } } } };
        expect(() =>
          resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
        ).toThrow(LegacyConfigValidateError);
      });

      it("does not synthesize an smtp section purely from an env override when [auth.email.smtp] is absent from the document", () => {
        stubEnv("SUPABASE_AUTH_EMAIL_SMTP_ENABLED", "true");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });
    });

    describe("auth.mfa env overrides", () => {
      // `auth.mfa.<factor>.*` is Viper-bound unconditionally (value-typed struct fields, never
      // `nil`) — unlike hooks/smtp above, no raw-document presence gate is needed; see the block
      // comment above the `mfa` array in legacy-local-config-values.ts.
      afterEach(() => {
        stubEnv("SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED", undefined);
        stubEnv("SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED", undefined);
      });

      it("rejects an env-enabled enroll factor left at its TOML-decoded verify default", () => {
        stubEnv("SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED", "true");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Invalid MFA config: auth.mfa.totp.enroll_enabled requires verify_enabled",
        );
      });

      it("accepts an env-enabled enroll factor when verify is also env-enabled", () => {
        stubEnv("SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED", "true");
        stubEnv("SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED", "true");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      it("rejects a malformed SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED override", () => {
        stubEnv("SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED", "not-a-bool");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          'Invalid config for auth.mfa.totp.enroll_enabled: cannot parse "not-a-bool" as a bool',
        );
      });
    });

    describe("auth.third_party env overrides", () => {
      // Same value-typed-struct reasoning as auth.mfa above — including `workos`, whose default
      // template omits `[auth.third_party.workos]` entirely yet is still unconditionally overridable.
      afterEach(() => {
        stubEnv("SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED", undefined);
        stubEnv("SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID", undefined);
      });

      it("rejects a third-party provider enabled only via env with no required field configured", () => {
        stubEnv("SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED", "true");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
          "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
        );
      });

      it("accepts an env-provided project_id overriding a TOML-enabled firebase provider", () => {
        stubEnv("SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID", "my-project");
        const config = baseConfig({ auth: { third_party: { firebase: { enabled: true } } } });
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });

      it("does not enable a third-party provider purely from a required-field env override", () => {
        stubEnv("SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID", "my-project");
        const config = baseConfig();
        expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
      });
    });

    describe("auth.email.template/notification (content_path validation)", () => {
      // `(e *email) validate(fsys)`,
      // called right after `Auth.MFA.validate()`, still inside `if c.Auth.Enabled`.
      const tempRoot = useLegacyTempWorkdir("supabase-email-templates-test-");

      it.effect("rejects a template content_path pointing at a missing file", () =>
        Effect.gen(function* () {
          const config = baseConfig({
            auth: {
              enabled: true,
              site_url: "http://localhost:3000",
              email: { template: { invite: { content_path: "missing-invite.html" } } },
            },
          });
          const exit = yield* Effect.exit(
            resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(String(exit.cause)).toContain(
              "Invalid config for auth.email.template.invite.content_path: ",
            );
        }),
      );

      it.effect(
        "resolves a relative template content_path against the workdir itself, not <workdir>/supabase",
        () =>
          Effect.gen(function* () {
            yield* writeFileEffect(join(tempRoot.current, "invite.html"), "<html></html>");
            const config = baseConfig({
              auth: {
                enabled: true,
                site_url: "http://localhost:3000",
                email: { template: { invite: { content_path: "invite.html" } } },
              },
            });
            yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
          }),
      );

      it.effect("does not throw a template with no content_path configured", () =>
        Effect.gen(function* () {
          const config = baseConfig({
            auth: {
              enabled: true,
              site_url: "http://localhost:3000",
              email: { template: { invite: {} } },
            },
          });
          yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
        }),
      );

      it.effect("rejects an enabled notification content_path pointing at a missing file", () =>
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
          const exit = yield* Effect.exit(
            resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(String(exit.cause)).toContain(
              "Invalid config for auth.email.notification.password_changed.content_path: ",
            );
        }),
      );

      it.effect("resolves a relative notification content_path against the workdir", () =>
        Effect.gen(function* () {
          const templateDir = join(tempRoot.current, "supabase", "templates");
          yield* makeDirectoryEffect(templateDir);
          yield* writeFileEffect(join(templateDir, "pw-changed.html"), "<html></html>");
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
          yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
        }),
      );

      it.effect("does not throw a disabled notification's missing content_path", () =>
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
          yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
        }),
      );

      it.effect("does not throw a missing template content_path when auth is disabled", () =>
        Effect.gen(function* () {
          const config = baseConfig({
            auth: {
              enabled: false,
              email: { template: { invite: { content_path: "missing.html" } } },
            },
          });
          yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
        }),
      );

      // Divergence #2 (see `legacy-config-validate.ts`'s port-plan notes): Go's asymmetric
      // content-vs-content_path exclusivity — a raw `content` key present
      // with no `content_path` is an error, not a silent no-op. `@supabase/config`'s schema has no
      // `content` field to see, so this only fires when the raw `document` (5th param) carries it.
      it.effect("rejects a template content key present without content_path", () =>
        Effect.gen(function* () {
          const config = baseConfig({
            auth: {
              enabled: true,
              site_url: "http://localhost:3000",
              email: { template: { invite: {} } },
            },
          });
          const exit = yield* Effect.exit(
            resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current, undefined, {
              auth: { email: { template: { invite: { content: "<html>Hi</html>" } } } },
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(String(exit.cause)).toContain(
              "Invalid config for auth.email.template.invite.content: please use content_path instead",
            );
        }),
      );
    });

    describe("auth.email.template/notification env overrides", () => {
      // `auth.email.template.<name>.*`/`auth.email.notification.<name>.*` are Viper-bound like any
      // other nested field once the section is present in config.toml. Unlike hook/passkey, no
      // extra raw-document presence gate is needed: `email.template`/`email.notification` are
      // `Schema.Record`s, so `Object.entries` on the decoded config already reflects presence.
      const tempRoot = useLegacyTempWorkdir("supabase-email-template-env-test-");

      afterEach(() => {
        stubEnv("SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH", undefined);
        stubEnv("SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT", undefined);
        stubEnv("SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED", undefined);
        stubEnv("SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT_PATH", undefined);
        stubEnv("SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT", undefined);
      });

      it.effect(
        "lets an env-provided template content_path override a missing TOML content_path",
        () =>
          Effect.gen(function* () {
            yield* writeFileEffect(join(tempRoot.current, "invite.html"), "<html></html>");
            stubEnv("SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH", "invite.html");
            const config = baseConfig({
              auth: {
                enabled: true,
                site_url: "http://localhost:3000",
                email: { template: { invite: {} } },
              },
            });
            yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
          }),
      );

      it.effect(
        "rejects a notification enabled only via env with a missing content_path file",
        () =>
          Effect.gen(function* () {
            // Go applies SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED before
            // Auth.Email.validate() decides whether to read content_path — a notification disabled
            // in TOML but enabled by env must still be checked.
            stubEnv("SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED", "true");
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
            const exit = yield* Effect.exit(
              resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
            );
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit))
              expect(String(exit.cause)).toContain(
                "Invalid config for auth.email.notification.password_changed.content_path: ",
              );
          }),
      );

      it.effect(
        "does not validate a notification disabled only via env despite a TOML-enabled section",
        () =>
          Effect.gen(function* () {
            stubEnv("SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED", "false");
            const config = baseConfig({
              auth: {
                enabled: true,
                site_url: "http://localhost:3000",
                email: {
                  notification: {
                    password_changed: { enabled: true, content_path: "missing.html" },
                  },
                },
              },
            });
            yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
          }),
      );

      it.effect(
        "lets an env-provided notification content_path override a missing TOML content_path",
        () =>
          Effect.gen(function* () {
            yield* writeFileEffect(join(tempRoot.current, "pw-changed.html"), "<html></html>");
            stubEnv(
              "SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT_PATH",
              "pw-changed.html",
            );
            const config = baseConfig({
              auth: {
                enabled: true,
                site_url: "http://localhost:3000",
                email: { notification: { password_changed: { enabled: true } } },
              },
            });
            yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
          }),
      );

      // Go's Viper `AutomaticEnv` folds a `SUPABASE_AUTH_EMAIL_TEMPLATE_<NAME>_CONTENT`/
      // `_NOTIFICATION_<NAME>_CONTENT` override into `Content *string` before `Config.Validate`
      // runs, so it's "present" for the content-vs-content_path exclusivity
      // check exactly like a raw TOML `content` key — a bare env override with no content_path
      // configured anywhere must be rejected, not silently accepted.
      it.effect("rejects a template _CONTENT env override with no content_path configured", () =>
        Effect.gen(function* () {
          stubEnv("SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT", "<html>Hi</html>");
          const config = baseConfig({
            auth: {
              enabled: true,
              site_url: "http://localhost:3000",
              email: { template: { invite: {} } },
            },
          });
          const exit = yield* Effect.exit(
            resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(String(exit.cause)).toContain(
              "Invalid config for auth.email.template.invite.content: please use content_path instead",
            );
        }),
      );

      it.effect(
        "rejects an enabled notification's _CONTENT env override with no content_path configured",
        () =>
          Effect.gen(function* () {
            stubEnv("SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT", "<html>Hi</html>");
            const config = baseConfig({
              auth: {
                enabled: true,
                site_url: "http://localhost:3000",
                email: { notification: { password_changed: { enabled: true } } },
              },
            });
            const exit = yield* Effect.exit(
              resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
            );
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit))
              expect(String(exit.cause)).toContain(
                "Invalid config for auth.email.notification.password_changed.content: please use content_path instead",
              );
          }),
      );

      it.effect("does not validate a disabled notification's _CONTENT env override", () =>
        Effect.gen(function* () {
          stubEnv("SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT", "<html>Hi</html>");
          const config = baseConfig({
            auth: {
              enabled: true,
              site_url: "http://localhost:3000",
              email: { notification: { password_changed: { enabled: false } } },
            },
          });
          yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
        }),
      );

      it.effect(
        "lets a simultaneous template _CONTENT_PATH env override win over a _CONTENT env override",
        () =>
          Effect.gen(function* () {
            yield* writeFileEffect(join(tempRoot.current, "invite.html"), "<html></html>");
            stubEnv("SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT", "<html>Hi</html>");
            stubEnv("SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH", "invite.html");
            const config = baseConfig({
              auth: {
                enabled: true,
                site_url: "http://localhost:3000",
                email: { template: { invite: {} } },
              },
            });
            yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
          }),
      );

      it.effect(
        "preserves a remote block's valid template content_path over a missing-file ambient override",
        () =>
          Effect.gen(function* () {
            // Regression (review: PRRT_kwDOErm0O86XLAYn): `content_path` is the field that can
            // actually abort resolution here — an ungated override let a stale/missing ambient
            // `_CONTENT_PATH` outrank a matched remote's own valid path, and the caller-side file read
            // (`readAuthEmailTemplateContent`) then threw, aborting the whole
            // `legacyResolveLocalConfigValues` call (and the shadow it feeds) on a value `v.Set`
            // (override tier, above `AutomaticEnv`) never lets win.
            yield* writeFileEffect(join(tempRoot.current, "invite.html"), "<html></html>");
            stubEnv("SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH", "missing.html");
            const config = baseConfig({
              auth: {
                enabled: true,
                site_url: "http://localhost:3000",
                email: { template: { invite: { content_path: "invite.html" } } },
              },
            });
            yield* resolveLocalConfigValuesEffect(
              config,
              "127.0.0.1",
              tempRoot.current,
              undefined,
              undefined,
              new Set(["auth.email.template.invite.content_path"]),
            );
          }),
      );

      it.effect(
        "still applies a template _CONTENT_PATH override to a missing file when no remote block matched",
        () =>
          Effect.gen(function* () {
            stubEnv("SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH", "missing.html");
            const config = baseConfig({
              auth: {
                enabled: true,
                site_url: "http://localhost:3000",
                email: { template: { invite: { content_path: "invite.html" } } },
              },
            });
            const exit = yield* Effect.exit(
              resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
            );
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit))
              expect(String(exit.cause)).toContain(
                "Invalid config for auth.email.template.invite.content_path: ",
              );
          }),
      );

      it.effect(
        "preserves a remote block's valid notification content_path over a missing-file ambient override",
        () =>
          Effect.gen(function* () {
            yield* writeFileEffect(join(tempRoot.current, "pw-changed.html"), "<html></html>");
            stubEnv(
              "SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_CONTENT_PATH",
              "missing.html",
            );
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
            yield* resolveLocalConfigValuesEffect(
              config,
              "127.0.0.1",
              tempRoot.current,
              undefined,
              undefined,
              new Set(["auth.email.notification.password_changed.content_path"]),
            );
          }),
      );
    });

    it.effect(
      "suppresses a malformed ambient notification _ENABLED when a remote block already set enabled",
      () =>
        Effect.gen(function* () {
          // `enabled` is a direct `legacyEnvOverrideBool` call, so a malformed ambient override
          // throws on its own regardless of the exclusivity/file-read checks above — same bug class
          // as `auth.email.enable_signup`/`.enable_confirmations` (review: PRRT_kwDOErm0O86XLAYo).
          stubEnv("SUPABASE_AUTH_EMAIL_NOTIFICATION_PASSWORD_CHANGED_ENABLED", "not-a-bool");
          const config = baseConfig({
            auth: {
              enabled: true,
              site_url: "http://localhost:3000",
              email: { notification: { password_changed: { enabled: false } } },
            },
          });
          yield* resolveLocalConfigValuesEffect(
            config,
            "127.0.0.1",
            WORKDIR,
            undefined,
            undefined,
            new Set(["auth.email.notification.password_changed.enabled"]),
          );
        }),
    );
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
    // `auth.external.<name>.*` is Viper-bound like any other nested field once
    // `[auth.external.<name>]` is present in config.toml — same gap the schema's own
    // `requiredWhenEnabled` check has for KNOWN providers too.
    afterEach(() => {
      stubEnv("SUPABASE_AUTH_EXTERNAL_CUSTOM_ENABLED", undefined);
      stubEnv("SUPABASE_AUTH_EXTERNAL_CUSTOM_CLIENT_ID", undefined);
      stubEnv("SUPABASE_AUTH_EXTERNAL_CUSTOM_SECRET", undefined);
    });

    it("rejects a provider enabled only via env with no client_id", () => {
      stubEnv("SUPABASE_AUTH_EXTERNAL_CUSTOM_ENABLED", "true");
      const config = baseConfig();
      const document = { auth: { external: { custom: { enabled: false } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.external.custom.client_id");
    });

    it("accepts env-provided client_id/secret overriding a TOML-enabled provider missing both", () => {
      stubEnv("SUPABASE_AUTH_EXTERNAL_CUSTOM_CLIENT_ID", "abc");
      stubEnv("SUPABASE_AUTH_EXTERNAL_CUSTOM_SECRET", "shh");
      const config = baseConfig();
      const document = { auth: { external: { custom: { enabled: true } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("does not synthesize a provider purely from an env override when the section is absent from the document", () => {
      stubEnv("SUPABASE_AUTH_EXTERNAL_CUSTOM_ENABLED", "true");
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("auth.sms env overrides (provider switch)", () => {
    // `(s *sms) validate()` is a `switch` that validates
    // ONLY the first enabled provider in a fixed priority order (twilio, twilio_verify,
    // messagebird, textlocal, vonage). `@supabase/config`'s schema already implements this switch
    // for the schema-decoded (pre-env-override) TOML value; this re-runs it against the raw
    // document with `SUPABASE_AUTH_SMS_*` overrides applied, since the schema never sees them.
    afterEach(() => {
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ENABLED", undefined);
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID", undefined);
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID", undefined);
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN", undefined);
      stubEnv("SUPABASE_AUTH_SMS_MESSAGEBIRD_ENABLED", undefined);
    });

    it("rejects a provider enabled only via env with missing required fields", () => {
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ENABLED", "true");
      const config = baseConfig();
      const document = { auth: { sms: { twilio: { enabled: false } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.sms.twilio.account_sid");
    });

    it("accepts env-provided credentials overriding a TOML-enabled provider missing them", () => {
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID", "AC123");
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID", "MG123");
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN", "tok");
      const config = baseConfig();
      const document = { auth: { sms: { twilio: { enabled: true } } } };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("only validates the first enabled provider in Go's fixed priority order", () => {
      // twilio is disabled via env; messagebird becomes the switch winner and is missing its
      // required fields — twilio's own (still-missing) fields must never be inspected.
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ENABLED", "false");
      stubEnv("SUPABASE_AUTH_SMS_MESSAGEBIRD_ENABLED", "true");
      const config = baseConfig();
      const document = {
        auth: { sms: { twilio: { enabled: true }, messagebird: { enabled: false } } },
      };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).toThrow("Missing required field in config: auth.sms.messagebird.originator");
    });

    it("throws for a provider enabled only via env with missing required fields even when the document has no auth.sms section at all", () => {
      // Unlike the other 4 providers, twilio's presence is NOT gated on the document: Go's
      // ejected default config.toml (`pkg/config/templates/config.toml:288-293`) always emits an
      // uncommented `[auth.sms.twilio]` table, so `mergeDefaultValues` registers
      // `auth.sms.twilio.*` with Viper even when the user's own config.toml has no `[auth.sms]`
      // section at all — `SUPABASE_AUTH_SMS_TWILIO_ENABLED` applies with nothing left to supply
      // the required credentials, so this now fails validation instead of silently doing nothing.
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ENABLED", "true");
      const config = baseConfig();
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
        "Missing required field in config: auth.sms.twilio.account_sid",
      );
    });

    it("resolves a fully env-only twilio configuration with no auth.sms.twilio document section", () => {
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ENABLED", "true");
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID", "AC123");
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID", "MG123");
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN", "tok");
      const resolved = legacyResolveAuthSms(undefined, baseConfig().auth.sms, testProjectEnvValues);
      expect(resolved.twilio.enabled).toBe(true);
      expect(resolved.twilio.account_sid).toBe("AC123");
      expect(resolved.twilio.message_service_sid).toBe("MG123");
      expect(resolved.twilio.auth_token).toBe("tok");
    });

    it("still does not synthesize messagebird purely from an env override when the section is absent from the document", () => {
      // messagebird (like twilio_verify/textlocal/vonage) has no entry at all in Go's default
      // template, so an absent `[auth.sms.messagebird]` table genuinely means Viper never
      // registers it — the presence gate is still correct parity for these 4 providers.
      stubEnv("SUPABASE_AUTH_SMS_MESSAGEBIRD_ENABLED", "true");
      const config = baseConfig();
      const resolved = legacyResolveAuthSms(undefined, config.auth.sms, testProjectEnvValues);
      expect(resolved.messagebird.enabled).toBe(false);
      expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).not.toThrow();
    });
  });

  describe("legacyResolveAuthSms (top-level scalars)", () => {
    afterEach(() => {
      stubEnv("SUPABASE_AUTH_SMS_ENABLE_SIGNUP", undefined);
      stubEnv("SUPABASE_AUTH_SMS_ENABLE_CONFIRMATIONS", undefined);
      stubEnv("SUPABASE_AUTH_SMS_MAX_FREQUENCY", undefined);
      stubEnv("SUPABASE_AUTH_SMS_TEMPLATE", undefined);
    });

    it("overrides enable_signup/enable_confirmations/max_frequency/template with no presence gate", () => {
      stubEnv("SUPABASE_AUTH_SMS_ENABLE_SIGNUP", "true");
      stubEnv("SUPABASE_AUTH_SMS_ENABLE_CONFIRMATIONS", "true");
      stubEnv("SUPABASE_AUTH_SMS_MAX_FREQUENCY", "10s");
      stubEnv("SUPABASE_AUTH_SMS_TEMPLATE", "Your OTP is {{ .Code }}");
      // A provider must be enabled, or `enable_signup` gets downgraded to `false` regardless of
      // the override — see the "disables phone login" tests below for that behavior itself.
      const configured = {
        ...baseConfig().auth.sms,
        twilio: { ...baseConfig().auth.sms.twilio, enabled: true },
      };
      const resolved = legacyResolveAuthSms(undefined, configured, testProjectEnvValues);
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
      const resolved = legacyResolveAuthSms(undefined, configured, testProjectEnvValues);
      expect(resolved.enable_signup).toBe(true);
      expect(resolved.max_frequency).toBe("5s");
    });
  });

  describe("legacyResolveAuthSms (disables phone login with no provider enabled)", () => {
    afterEach(() => {
      stubEnv("SUPABASE_AUTH_SMS_ENABLE_SIGNUP", undefined);
    });

    it("downgrades enable_signup to false when configured true with no provider enabled", () => {
      const configured = { ...baseConfig().auth.sms, enable_signup: true };
      const resolved = legacyResolveAuthSms(undefined, configured, testProjectEnvValues);
      expect(resolved.enable_signup).toBe(false);
    });

    it("downgrades an env-overridden enable_signup to false with no provider enabled", () => {
      stubEnv("SUPABASE_AUTH_SMS_ENABLE_SIGNUP", "true");
      const resolved = legacyResolveAuthSms(undefined, baseConfig().auth.sms, testProjectEnvValues);
      expect(resolved.enable_signup).toBe(false);
    });

    it("leaves enable_signup alone when a provider is enabled", () => {
      const configured = {
        ...baseConfig().auth.sms,
        enable_signup: true,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true },
      };
      const resolved = legacyResolveAuthSms(undefined, configured, testProjectEnvValues);
      expect(resolved.enable_signup).toBe(true);
    });

    it("leaves enable_signup at false when already false with no provider enabled", () => {
      const resolved = legacyResolveAuthSms(undefined, baseConfig().auth.sms, testProjectEnvValues);
      expect(resolved.enable_signup).toBe(false);
    });
  });

  describe("legacyResolveAuthSms — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
    // Regression (review: PRRT_kwDOErm0O86XFmjZ) — a prior review rejected this exact gap as
    // "unreachable from the db diff --linked/db pull shadow path," having only grepped direct
    // `legacyResolveAuthSms(` call sites in `start.handler.ts`/`db/start/start.handler.ts` and
    // missed that `legacyResolveLocalConfigValues` (this function's own shadow-consuming caller,
    // via `legacyBuildLocalDbContainerInputs`) calls it too, through its own
    // `validateAuthSmsProviders` wrapper, whenever `authEnabled`. `enable_signup`/
    // `enable_confirmations`/each provider's `enabled` THROW via `legacyEnvOverrideBool`, and each
    // provider's Secret-typed field THROWS via `legacyDecryptAuthSecret` — either can abort the
    // whole `legacyResolveLocalConfigValues` call (and the shadow it feeds) on a malformed ambient
    // override even when a matched remote block already set that field.
    afterEach(() => {
      stubEnv("SUPABASE_AUTH_SMS_ENABLE_SIGNUP", undefined);
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_ENABLED", undefined);
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_API_SECRET", undefined);
    });

    it("suppresses a malformed SUPABASE_AUTH_SMS_ENABLE_SIGNUP when a remote block already set auth.sms.enable_signup", () => {
      stubEnv("SUPABASE_AUTH_SMS_ENABLE_SIGNUP", "not-a-bool");
      const configured = {
        ...baseConfig().auth.sms,
        enable_signup: true,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true },
      };
      expect(() =>
        legacyResolveAuthSms(
          undefined,
          configured,
          testProjectEnvValues,
          new Set(["auth.sms.enable_signup"]),
        ),
      ).not.toThrow();
    });

    it("still rejects a malformed SUPABASE_AUTH_SMS_ENABLE_SIGNUP when no remote block matched", () => {
      stubEnv("SUPABASE_AUTH_SMS_ENABLE_SIGNUP", "not-a-bool");
      const configured = {
        ...baseConfig().auth.sms,
        enable_signup: true,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true },
      };
      expect(() => legacyResolveAuthSms(undefined, configured, testProjectEnvValues)).toThrow(
        'cannot parse "not-a-bool" as a bool',
      );
    });

    it("suppresses a malformed SUPABASE_AUTH_SMS_VONAGE_ENABLED when a remote block already set auth.sms.vonage.enabled", () => {
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_ENABLED", "not-a-bool");
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true },
      };
      expect(() =>
        legacyResolveAuthSms(
          undefined,
          configured,
          testProjectEnvValues,
          new Set(["auth.sms.vonage.enabled"]),
        ),
      ).not.toThrow();
    });

    it("prefers a remote-set auth.sms.vonage.api_secret over a malformed SUPABASE_AUTH_SMS_VONAGE_API_SECRET", () => {
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_API_SECRET", "encrypted:garbage");
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true, api_secret: "remote-secret" },
      };
      const resolved = legacyResolveAuthSms(
        undefined,
        configured,
        testProjectEnvValues,
        new Set(["auth.sms.vonage.enabled", "auth.sms.vonage.api_secret"]),
      );
      expect(resolved.vonage.api_secret).toBe("remote-secret");
    });

    it("still rejects a malformed SUPABASE_AUTH_SMS_VONAGE_API_SECRET when no remote block matched", () => {
      // `vonage` isn't `twilio` (the one provider Go's default template always registers), so the
      // env override is only consulted at all when the raw `[auth.sms.vonage]` table is present —
      // same presence gate `providerPresent` already applies for the remote-set case above.
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_API_SECRET", "encrypted:garbage");
      const authDocument = { sms: { vonage: {} } };
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, enabled: true, api_secret: "remote-secret" },
      };
      expect(() => legacyResolveAuthSms(authDocument, configured, testProjectEnvValues)).toThrow(
        "failed to parse config: missing private key",
      );
    });

    // Regression: `resolveField`'s non-secret provider leaves (`account_sid`/`message_service_sid`/
    // `originator`/`sender`/`from`/`api_key`) had no `remoteWins` branch at all — `vonage.api_key`
    // sitting right next to the already-gated `vonage.api_secret` was the clearest tell.
    it("prefers a remote-set auth.sms.twilio.account_sid over a conflicting SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID", () => {
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID", "env-sid");
      const configured = {
        ...baseConfig().auth.sms,
        twilio: { ...baseConfig().auth.sms.twilio, account_sid: "remote-sid" },
      };
      const resolved = legacyResolveAuthSms(
        undefined,
        configured,
        undefined,
        new Set(["auth.sms.twilio.account_sid"]),
      );
      expect(resolved.twilio.account_sid).toBe("remote-sid");
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID", undefined);
    });

    it("still applies SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID when no remote block matched", () => {
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID", "env-sid");
      const configured = {
        ...baseConfig().auth.sms,
        twilio: { ...baseConfig().auth.sms.twilio, account_sid: "remote-sid" },
      };
      const resolved = legacyResolveAuthSms(undefined, configured, testProjectEnvValues);
      expect(resolved.twilio.account_sid).toBe("env-sid");
      stubEnv("SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID", undefined);
    });

    it("prefers a remote-set auth.sms.vonage.from over a conflicting SUPABASE_AUTH_SMS_VONAGE_FROM", () => {
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_FROM", "env-from");
      const authDocument = { sms: { vonage: { from: "remote-from" } } };
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, from: "remote-from" },
      };
      const resolved = legacyResolveAuthSms(
        authDocument,
        configured,
        undefined,
        new Set(["auth.sms.vonage.from"]),
      );
      expect(resolved.vonage.from).toBe("remote-from");
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_FROM", undefined);
    });

    it("still applies SUPABASE_AUTH_SMS_VONAGE_FROM when no remote block matched", () => {
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_FROM", "env-from");
      const authDocument = { sms: { vonage: { from: "remote-from" } } };
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, from: "remote-from" },
      };
      const resolved = legacyResolveAuthSms(authDocument, configured, testProjectEnvValues);
      expect(resolved.vonage.from).toBe("env-from");
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_FROM", undefined);
    });

    it("prefers a remote-set auth.sms.vonage.api_key over a conflicting SUPABASE_AUTH_SMS_VONAGE_API_KEY", () => {
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_API_KEY", "env-key");
      const authDocument = { sms: { vonage: { api_key: "remote-key" } } };
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, api_key: "remote-key" },
      };
      const resolved = legacyResolveAuthSms(
        authDocument,
        configured,
        undefined,
        new Set(["auth.sms.vonage.api_key"]),
      );
      expect(resolved.vonage.api_key).toBe("remote-key");
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_API_KEY", undefined);
    });

    it("still applies SUPABASE_AUTH_SMS_VONAGE_API_KEY when no remote block matched", () => {
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_API_KEY", "env-key");
      const authDocument = { sms: { vonage: { api_key: "remote-key" } } };
      const configured = {
        ...baseConfig().auth.sms,
        vonage: { ...baseConfig().auth.sms.vonage, api_key: "remote-key" },
      };
      const resolved = legacyResolveAuthSms(authDocument, configured, testProjectEnvValues);
      expect(resolved.vonage.api_key).toBe("env-key");
      stubEnv("SUPABASE_AUTH_SMS_VONAGE_API_KEY", undefined);
    });

    it("prefers a remote-set auth.sms.template over a conflicting SUPABASE_AUTH_SMS_TEMPLATE", () => {
      stubEnv("SUPABASE_AUTH_SMS_TEMPLATE", "env template");
      const configured = { ...baseConfig().auth.sms, template: "remote template" };
      const resolved = legacyResolveAuthSms(
        undefined,
        configured,
        testProjectEnvValues,
        new Set(["auth.sms.template"]),
      );
      expect(resolved.template).toBe("remote template");
      stubEnv("SUPABASE_AUTH_SMS_TEMPLATE", undefined);
    });

    it("still applies SUPABASE_AUTH_SMS_TEMPLATE when no remote block matched", () => {
      stubEnv("SUPABASE_AUTH_SMS_TEMPLATE", "env template");
      const configured = { ...baseConfig().auth.sms, template: "remote template" };
      const resolved = legacyResolveAuthSms(undefined, configured, testProjectEnvValues);
      expect(resolved.template).toBe("env template");
      stubEnv("SUPABASE_AUTH_SMS_TEMPLATE", undefined);
    });

    it("prefers a remote-set auth.sms.max_frequency over a conflicting SUPABASE_AUTH_SMS_MAX_FREQUENCY", () => {
      stubEnv("SUPABASE_AUTH_SMS_MAX_FREQUENCY", "5s");
      const configured = { ...baseConfig().auth.sms, max_frequency: "1m" };
      const resolved = legacyResolveAuthSms(
        undefined,
        configured,
        testProjectEnvValues,
        new Set(["auth.sms.max_frequency"]),
      );
      expect(resolved.max_frequency).toBe("1m");
      stubEnv("SUPABASE_AUTH_SMS_MAX_FREQUENCY", undefined);
    });

    it("still applies SUPABASE_AUTH_SMS_MAX_FREQUENCY when no remote block matched", () => {
      stubEnv("SUPABASE_AUTH_SMS_MAX_FREQUENCY", "5s");
      const configured = { ...baseConfig().auth.sms, max_frequency: "1m" };
      const resolved = legacyResolveAuthSms(undefined, configured, testProjectEnvValues);
      expect(resolved.max_frequency).toBe("5s");
      stubEnv("SUPABASE_AUTH_SMS_MAX_FREQUENCY", undefined);
    });

    it("still aborts legacyResolveLocalConfigValues on a malformed SUPABASE_AUTH_SMS_ENABLE_SIGNUP reached via validateAuthSmsProviders, unless remoteOverrideKeys suppresses it", () => {
      // End-to-end proof that the gap is reachable from the exact function this PR's shadow
      // provisioning calls (`legacyBuildLocalDbContainerInputs` -> `legacyResolveLocalConfigValues`
      // -> `validateAuthSmsProviders` -> `legacyResolveAuthSms`), not just the standalone resolver.
      // Built by spreading an already-decoded `baseConfig()` (not re-decoding through
      // `ProjectConfigSchema` via `baseConfig({...})`'s shallow-merge overrides) so `vonage`'s
      // other schema-required fields (`from`, etc.) keep their valid decoded defaults.
      stubEnv("SUPABASE_AUTH_SMS_ENABLE_SIGNUP", "not-a-bool");
      const base = baseConfig();
      const config: ProjectConfig = {
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
    const tempRoot = useLegacyTempWorkdir("supabase-api-tls-test-");

    function writeTlsFile(workdir: string, name: string, contents = "dummy") {
      const supabaseDir = join(workdir, "supabase");
      return Effect.gen(function* () {
        yield* makeDirectoryEffect(supabaseDir);
        yield* writeFileEffect(join(supabaseDir, name), contents);
      });
    }

    it.effect("does not throw when tls.enabled with neither cert_path nor key_path set", () =>
      Effect.gen(function* () {
        // Go's Validate only rejects the "exactly one set" case;
        // tls.enabled with nothing configured still loads.
        const config = baseConfig({ api: { tls: { enabled: true } } });
        yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
      }),
    );

    // The "exactly one of cert/key set" presence-only assertions moved to
    // `legacy-config-validate.unit.test.ts` (direct `legacyValidateResolvedConfig` calls) —
    // the actual file reads below stay here, since I/O is per-caller.

    it.effect("throws a Go-worded error when the configured cert file does not exist", () =>
      Effect.gen(function* () {
        yield* writeTlsFile(tempRoot.current, "key.pem");
        const config = baseConfig({
          api: { tls: { enabled: true, cert_path: "missing-cert.pem", key_path: "key.pem" } },
        });
        const exit = yield* Effect.exit(
          resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("failed to read TLS cert: ");
      }),
    );

    it.effect("throws a Go-worded error when the configured key file does not exist", () =>
      Effect.gen(function* () {
        yield* writeTlsFile(tempRoot.current, "cert.pem");
        const config = baseConfig({
          api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "missing-key.pem" } },
        });
        const exit = yield* Effect.exit(
          resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("failed to read TLS key: ");
      }),
    );

    it.effect("succeeds when both cert_path and key_path are readable", () =>
      Effect.gen(function* () {
        yield* writeTlsFile(tempRoot.current, "cert.pem");
        yield* writeTlsFile(tempRoot.current, "key.pem");
        const config = baseConfig({
          api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "key.pem" } },
        });
        yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
      }),
    );

    it.effect(
      "resolves cert_path/key_path against <workdir>/supabase unconditionally, no isAbsolute guard",
      () =>
        Effect.gen(function* () {
          // `path.Join` absorbs a leading "/" — unlike
          // signing_keys_path, which Go DOES guard with filepath.IsAbs.
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
          yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
        }),
    );

    // `Validate` nests the whole TLS branch inside `if c.Api.Enabled` —
    // a disabled api section never validates cert/key,
    // however invalid the pairing.
    it.effect("skips TLS validation entirely when api is disabled", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          api: { enabled: false, tls: { enabled: true, cert_path: "missing-cert.pem" } },
        });
        yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
      }),
    );

    describe("SUPABASE_API_ENABLED / SUPABASE_API_TLS_ENABLED env overrides", () => {
      afterEach(() => {
        stubEnv("SUPABASE_API_ENABLED", undefined);
        stubEnv("SUPABASE_API_TLS_ENABLED", undefined);
      });

      it.effect("skips TLS validation when api is disabled only via env", () =>
        Effect.gen(function* () {
          stubEnv("SUPABASE_API_ENABLED", "false");
          const config = baseConfig({
            api: { enabled: true, tls: { enabled: true, cert_path: "missing-cert.pem" } },
          });
          yield* resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current);
        }),
      );

      it.effect(
        "validates TLS when enabled only via env despite TOML saying tls.enabled = false",
        () =>
          Effect.gen(function* () {
            stubEnv("SUPABASE_API_TLS_ENABLED", "true");
            const config = baseConfig({
              api: { tls: { enabled: false, cert_path: "missing-cert.pem" } },
            });
            const exit = yield* Effect.exit(
              resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
            );
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit))
              expect(String(exit.cause)).toContain(
                "Missing required field in config: api.tls.key_path",
              );
          }),
      );
    });
  });
});

describe("legacyResolveLocalConfigValues — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
  // `mergeRemoteConfig` installs every matched `[remotes.<ref>]` leaf at viper's OVERRIDE
  // tier, above `AutomaticEnv` — so once a remote
  // block sets a field, a conflicting `SUPABASE_*` env var must never be consulted for it.
  // `legacyResolveDbBootstrapConfig`/`legacyResolveDbSettingsEnvOverrides` already gated this
  // (review: PRRT_kwDOErm0O86W2LL4); this covers the remaining leaves this resolver derives
  // that the shadow's own container/setup spec also consumes (review: PRRT_kwDOErm0O86W2tRi).
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
      stubEnv(name, undefined);
    }
  });

  const tempRoot = useLegacyTempWorkdir("supabase-remote-signing-keys-test-");

  it.effect(
    "prefers a remote-set auth.signing_keys_path over a conflicting SUPABASE_AUTH_SIGNING_KEYS_PATH",
    () =>
      Effect.gen(function* () {
        // Regression (review: PRRT_kwDOErm0O86W3Ox_): `legacyResolveConfiguredSigningKeys` — shared
        // by this function's own `anonKey`/`serviceRoleKey` asymmetric signing and by
        // `legacyResolveLocalJwks` — used to reapply a conflicting env override even when a remote
        // block already set `auth.signing_keys_path`, which would have pointed the shadow's
        // asymmetric signing at the wrong (env-supplied) file.
        yield* writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
        stubEnv("SUPABASE_AUTH_SIGNING_KEYS_PATH", "missing-file.json");
        const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
        yield* resolveLocalConfigValuesEffect(
          config,
          "127.0.0.1",
          tempRoot.current,
          undefined,
          undefined,
          new Set(["auth.signing_keys_path"]),
        );
      }),
  );

  it.effect(
    "still rejects a missing SUPABASE_AUTH_SIGNING_KEYS_PATH override when no remote block matched",
    () =>
      Effect.gen(function* () {
        yield* writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
        stubEnv("SUPABASE_AUTH_SIGNING_KEYS_PATH", "missing-file.json");
        const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
        const exit = yield* Effect.exit(
          resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(String(exit.cause)).toContain("failed to read signing keys: ");
      }),
  );

  it("suppresses a malformed SUPABASE_DB_MAJOR_VERSION when a remote block already set db.major_version", () => {
    // Regression (review: PRRT_kwDOErm0O86W2tRi): this function validates `db.major_version`
    // early but has no `majorVersion` field on its own return type (the shadow's actually-
    // consumed value comes from the already-gated `legacyResolveDbBootstrapConfig`) — before
    // this fix, the validate-only read here still decoded a conflicting env var unconditionally,
    // so a malformed value the remote block should have made irrelevant failed config loading
    // outright instead of the command proceeding on the remote's value, matching Go.
    stubEnv("SUPABASE_DB_MAJOR_VERSION", "abc");
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
    stubEnv("SUPABASE_DB_MAJOR_VERSION", "abc");
    const config = baseConfig({ db: { major_version: 14 } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "Invalid db.major_version: abc",
    );
  });

  it("prefers a remote-set auth.jwt_secret over a conflicting SUPABASE_AUTH_JWT_SECRET", () => {
    stubEnv("SUPABASE_AUTH_JWT_SECRET", "env-supplied-secret-value-1234567890");
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
    stubEnv("SUPABASE_DB_ROOT_KEY", "env-root-key");
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
    // Regression (review: PRRT_kwDOErm0O86W93Ex): this function's OWN validation-only
    // `thirdParty` array used to gate `enabled` on `remoteWins` but leave the sibling
    // `requiredField` (domain/tenant/user_pool_id/issuer_url) ungated — even though
    // `auth.third_party.clerk.domain` is already tracked in `LEGACY_ENV_OVERRIDABLE_KEYS`. A
    // matched remote's valid domain lost to a conflicting, invalid `SUPABASE_AUTH_THIRD_PARTY_
    // CLERK_DOMAIN`, so `legacyValidateResolvedConfig`'s Clerk domain-regex check rejected an
    // otherwise-valid, remote-backed configuration before the shadow was ever created — Go's
    // `mergeRemoteConfig` sets the whole matched block at viper's OVERRIDE tier, above
    // `AutomaticEnv`, so the env var is never even consulted once a remote sets this key.
    stubEnv("SUPABASE_AUTH_THIRD_PARTY_CLERK_ENABLED", "false");
    stubEnv("SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN", "not-a-clerk-domain");
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
    stubEnv("SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN", "not-a-clerk-domain");
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
    const tempRoot = useLegacyTempWorkdir("supabase-api-tls-remote-test-");

    function writeTlsFile(workdir: string, name: string, contents = "dummy") {
      const supabaseDir = join(workdir, "supabase");
      return Effect.gen(function* () {
        yield* makeDirectoryEffect(supabaseDir);
        yield* writeFileEffect(join(supabaseDir, name), contents);
      });
    }

    afterEach(() => {
      stubEnv("SUPABASE_API_TLS_CERT_PATH", undefined);
      stubEnv("SUPABASE_API_TLS_KEY_PATH", undefined);
    });

    it.effect(
      "prefers a remote-set api.tls.cert_path/key_path over a conflicting (missing-file) env override",
      () =>
        Effect.gen(function* () {
          // The ambient env vars point at files that don't exist — if they won, `readApiTlsFiles`
          // would throw. `mergeRemoteConfig` installs the matched remote block's cert/key
          // paths at viper's OVERRIDE tier (above `AutomaticEnv`), so they must win instead and the
          // load must succeed using the real, remote-supplied paths.
          yield* writeTlsFile(tempRoot.current, "cert.pem");
          yield* writeTlsFile(tempRoot.current, "key.pem");
          stubEnv("SUPABASE_API_TLS_CERT_PATH", "missing-cert.pem");
          stubEnv("SUPABASE_API_TLS_KEY_PATH", "missing-key.pem");
          const config = baseConfig({
            api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "key.pem" } },
          });
          yield* resolveLocalConfigValuesEffect(
            config,
            "127.0.0.1",
            tempRoot.current,
            undefined,
            undefined,
            new Set(["api.tls.cert_path", "api.tls.key_path"]),
          );
        }),
    );

    it.effect("still uses the env override when no remote block matched", () =>
      Effect.gen(function* () {
        yield* writeTlsFile(tempRoot.current, "cert.pem");
        stubEnv("SUPABASE_API_TLS_CERT_PATH", "missing-cert.pem");
        const config = baseConfig({
          api: { tls: { enabled: true, cert_path: "cert.pem", key_path: "cert.pem" } },
        });
        const exit = yield* Effect.exit(
          resolveLocalConfigValuesEffect(config, "127.0.0.1", tempRoot.current),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("failed to read TLS cert: ");
      }),
    );
  });

  it("prefers remote-set api.port/api.tls.enabled/api.external_url over conflicting env overrides", () => {
    stubEnv("SUPABASE_API_PORT", "9999");
    stubEnv("SUPABASE_API_TLS_ENABLED", "true");
    stubEnv("SUPABASE_API_EXTERNAL_URL", "https://env-should-not-win.test");
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
    stubEnv("SUPABASE_DB_PORT", "9999");
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
    stubEnv("SUPABASE_AUTH_SITE_URL", "https://env-should-not-win.test");
    stubEnv("SUPABASE_AUTH_JWT_EXPIRY", "9999");
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
    stubEnv("SUPABASE_AUTH_ANON_KEY", "env-anon-key");
    stubEnv("SUPABASE_AUTH_SERVICE_ROLE_KEY", "env-service-role-key");
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
    // Regression (review: PRRT_kwDOErm0O86XKYiF's sibling gap): `studio.api_url` feeds
    // `legacyValidateResolvedConfig`'s `legacyGoUrlParse` check, which throws on a malformed URL
    // even though the read itself (`legacyEnvOverride`) never does — same "non-throwing read,
    // throwing downstream consumer" bug class as `legacyResolveAuthHooks`'s `uri`/`secrets`.
    stubEnv("SUPABASE_STUDIO_API_URL", "http://[::1");
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
    // Regression: `studio.openai_api_key` is a `config.Secret`,
    // decrypted the same way `anon_key`/`service_role_key` above are — an ungated
    // `legacyEnvOverride` here could let a malformed ambient override outrank a matched remote's
    // own valid value and throw during decryption.
    stubEnv("SUPABASE_STUDIO_OPENAI_API_KEY", "encrypted:not-a-real-ciphertext");
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
    stubEnv("SUPABASE_STUDIO_OPENAI_API_KEY", "encrypted:not-a-real-ciphertext");
    const config = baseConfig({ studio: { openai_api_key: "remote-openai-key" } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "failed to parse config: missing private key",
    );
  });

  it("prefers remote-set auth.publishable_key/auth.secret_key over conflicting env overrides", () => {
    // Regression: `auth.publishable_key`/`auth.secret_key` are
    // `config.Secret`-typed exactly like `anon_key`/`service_role_key` above, but were missed
    // when that sibling pair was gated.
    stubEnv("SUPABASE_AUTH_PUBLISHABLE_KEY", "encrypted:not-a-real-ciphertext");
    stubEnv("SUPABASE_AUTH_SECRET_KEY", "encrypted:not-a-real-ciphertext");
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
    stubEnv("SUPABASE_AUTH_PUBLISHABLE_KEY", "encrypted:not-a-real-ciphertext");
    const config = baseConfig({ auth: { publishable_key: "remote-publishable-key" } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "failed to parse config: missing private key",
    );
  });

  it("still rejects a malformed SUPABASE_AUTH_SECRET_KEY when no remote block matched", () => {
    stubEnv("SUPABASE_AUTH_SECRET_KEY", "encrypted:not-a-real-ciphertext");
    const config = baseConfig({ auth: { secret_key: "remote-secret-key" } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "failed to parse config: missing private key",
    );
  });

  it("suppresses a malformed SUPABASE_DB_SETTINGS_MAX_CONNECTIONS when the remote block set db.settings.max_connections", () => {
    // Same validate-only shape as `db.major_version` above — `legacyResolveDbSettingsEnvOverrides`
    // is threaded `remoteOverrideKeys` here too, not just at its OWN (already-gated) call site
    // in `legacyResolveDbBootstrapConfig`.
    stubEnv("SUPABASE_DB_SETTINGS_MAX_CONNECTIONS", "not-a-number");
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
    // Regression (review: PRRT_kwDOErm0O86W30n6): `auth.enabled` gates the signing-keys file
    // read/validate-only auth block below but has no `authEnabled` field on its own return type —
    // before this fix, the ungated `legacyEnvOverrideBool` call still decoded a conflicting env
    // var unconditionally, so a malformed value the remote block should have made irrelevant
    // failed this WHOLE function (and therefore the shadow's `dbPort`/`jwtSecret`/etc. it also
    // resolves) instead of the command proceeding on the remote's value, matching Go.
    stubEnv("SUPABASE_AUTH_ENABLED", "not-a-bool");
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
    stubEnv("SUPABASE_AUTH_ENABLED", "not-a-bool");
    const config = baseConfig({ auth: { enabled: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for auth.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_ANALYTICS_ENABLED when a remote block already set analytics.enabled", () => {
    // Same class of gap as `auth.enabled` above — `analytics.enabled` is also in
    // `LEGACY_ENV_OVERRIDABLE_KEYS` and `analyticsEnabled` is never read by the shadow's own
    // container inputs, but an ungated `legacyEnvOverrideBool` call still aborts this whole
    // function on a malformed override the remote block should have made irrelevant.
    stubEnv("SUPABASE_ANALYTICS_ENABLED", "not-a-bool");
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
    stubEnv("SUPABASE_ANALYTICS_ENABLED", "not-a-bool");
    const config = baseConfig({ analytics: { enabled: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for analytics.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("prefers a remote-set analytics.gcp_project_id over a conflicting SUPABASE_ANALYTICS_GCP_PROJECT_ID", () => {
    stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_ID", "env-project");
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
    stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_ID", undefined);
  });

  it("still applies SUPABASE_ANALYTICS_GCP_PROJECT_ID when no remote block matched", () => {
    stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_ID", "env-project");
    const config = baseConfig({ analytics: { gcp_project_id: "remote-project" } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.gcpProjectId).toBe("env-project");
    stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_ID", undefined);
  });

  it("prefers a remote-set analytics.gcp_project_number over a conflicting SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER", () => {
    stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER", "999");
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
    stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER", undefined);
  });

  it("still applies SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER when no remote block matched", () => {
    stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER", "999");
    const config = baseConfig({ analytics: { gcp_project_number: "111" } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.gcpProjectNumber).toBe("999");
    stubEnv("SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER", undefined);
  });

  it("prefers a remote-set analytics.gcp_jwt_path over a conflicting SUPABASE_ANALYTICS_GCP_JWT_PATH", () => {
    stubEnv("SUPABASE_ANALYTICS_GCP_JWT_PATH", "env-key.json");
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
    stubEnv("SUPABASE_ANALYTICS_GCP_JWT_PATH", undefined);
  });

  it("still applies SUPABASE_ANALYTICS_GCP_JWT_PATH when no remote block matched", () => {
    stubEnv("SUPABASE_ANALYTICS_GCP_JWT_PATH", "env-key.json");
    const config = baseConfig({ analytics: { gcp_jwt_path: "remote-key.json" } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.gcpJwtPath).toBe("env-key.json");
    stubEnv("SUPABASE_ANALYTICS_GCP_JWT_PATH", undefined);
  });

  it("prefers a remote-set auth.jwt_issuer over a conflicting SUPABASE_AUTH_JWT_ISSUER", () => {
    stubEnv("SUPABASE_AUTH_JWT_ISSUER", "https://env.example.com");
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
    stubEnv("SUPABASE_AUTH_JWT_ISSUER", undefined);
  });

  it("still applies SUPABASE_AUTH_JWT_ISSUER when no remote block matched", () => {
    stubEnv("SUPABASE_AUTH_JWT_ISSUER", "https://env.example.com");
    const config = baseConfig({ auth: { jwt_issuer: "https://remote.example.com" } });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.authJwtIssuer).toBe("https://env.example.com");
    stubEnv("SUPABASE_AUTH_JWT_ISSUER", undefined);
  });

  it("prefers a remote-set auth.additional_redirect_urls over a conflicting SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS", () => {
    stubEnv("SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS", "https://env.example.com");
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
    stubEnv("SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS", undefined);
  });

  it("still applies SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS when no remote block matched", () => {
    stubEnv("SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS", "https://env.example.com");
    const config = baseConfig({
      auth: { additional_redirect_urls: ["https://remote.example.com"] },
    });
    const values = resolveLocalConfigValues(config, "127.0.0.1", WORKDIR);
    expect(values.authAdditionalRedirectUrls).toEqual(["https://env.example.com"]);
    stubEnv("SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS", undefined);
  });

  describe("auth.webauthn.rp_id / auth.webauthn.rp_origins — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
    // `rpId`/`rpOrigins` aren't part of this function's return value (only
    // `legacyValidateResolvedConfig`'s passkey step consumes them), so precedence is proven
    // through that step's emptiness check: the document deliberately leaves the field EMPTY (a
    // real, present-but-empty state, not "absent") while the env var supplies a non-empty value —
    // ungated, the non-throwing env value wins and validation passes; gated, the remote's own
    // (empty) value wins and validation throws exactly like `Validate` would for a
    // `[remotes.*]`-supplied empty field.
    afterEach(() => {
      stubEnv("SUPABASE_AUTH_PASSKEY_ENABLED", undefined);
      stubEnv("SUPABASE_AUTH_WEBAUTHN_RP_ID", undefined);
      stubEnv("SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS", undefined);
    });

    it("suppresses a non-empty SUPABASE_AUTH_WEBAUTHN_RP_ID when a remote block already set (empty) auth.webauthn.rp_id", () => {
      stubEnv("SUPABASE_AUTH_WEBAUTHN_RP_ID", "localhost");
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
      stubEnv("SUPABASE_AUTH_WEBAUTHN_RP_ID", "localhost");
      const config = baseConfig();
      const document = {
        auth: { passkey: { enabled: true }, webauthn: { rp_id: "", rp_origins: ["http://x"] } },
      };
      expect(() =>
        resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
      ).not.toThrow();
    });

    it("suppresses a non-empty SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS when a remote block already set (empty) auth.webauthn.rp_origins", () => {
      stubEnv("SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS", "http://localhost:3000");
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
      stubEnv("SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS", "http://localhost:3000");
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
    // Same class of gap as `auth.enabled`/`analytics.enabled` above, for this function's OWN
    // validation-only `thirdParty` block (distinct from `legacyResolveLocalJwks`'s own, already-
    // gated `thirdParty` — see that param's doc comment). Auth must be enabled for this block to
    // run at all.
    stubEnv("SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED", "not-a-bool");
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
    stubEnv("SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED", "not-a-bool");
    const config = baseConfig({
      auth: { enabled: true, third_party: { firebase: { enabled: false } } },
    });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for auth.third_party.firebase.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_EDGE_RUNTIME_DENO_VERSION when a remote block already set edge_runtime.deno_version", () => {
    // Regression (review: PRRT_kwDOErm0O86W4gCk): same class of gap as `auth.enabled`/
    // `analytics.enabled` above — `edge_runtime.deno_version` is also in
    // `LEGACY_ENV_OVERRIDABLE_KEYS` and `denoVersion` is never read by the shadow's own
    // container inputs, but an ungated `legacyEnvOverrideDenoVersion` call still aborts this
    // whole function on a malformed override the remote block should have made irrelevant.
    stubEnv("SUPABASE_EDGE_RUNTIME_DENO_VERSION", "abc");
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
    stubEnv("SUPABASE_EDGE_RUNTIME_DENO_VERSION", "abc");
    const config = baseConfig({ edge_runtime: { deno_version: 2 } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      "Failed reading config: Invalid edge_runtime.deno_version: abc.",
    );
  });

  it("suppresses a malformed SUPABASE_API_ENABLED when a remote block already set api.enabled", () => {
    // Regression (review: PRRT_kwDOErm0O86W5UlV): same class of gap as `auth.enabled`/
    // `analytics.enabled`/`edge_runtime.deno_version` above — `api.enabled` is also in
    // `LEGACY_ENV_OVERRIDABLE_KEYS` and `apiEnabled` is never read by the shadow's own
    // container inputs (unlike its siblings `apiTlsEnabled`/`apiPort`, which feed `apiUrl`),
    // but an ungated `legacyEnvOverrideBool` call still aborts this whole function — denying
    // it `apiPort`/`apiUrl`/`dbPort`/`rootKey`/etc. too — on a malformed override the remote
    // block should have made irrelevant.
    stubEnv("SUPABASE_API_ENABLED", "not-a-bool");
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
    stubEnv("SUPABASE_API_ENABLED", "not-a-bool");
    const config = baseConfig({ api: { enabled: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for api.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_STUDIO_ENABLED when a remote block already set studio.enabled", () => {
    // Regression (review: PRRT_kwDOErm0O86W6R-G): the doc comment on this function's
    // `remoteOverrideKeys` parameter used to claim `studio`/`local_smtp`/the auth
    // enable_signup/-anonymous_sign_ins/refresh-token/manual-linking/password-length/
    // -requirements group/passkey/hooks/mfa/captcha/email.smtp/experimental.webhooks fields could
    // stay ungated because their own `legacyEnvOverride*` calls "cannot throw before a value the
    // caller needs has already been resolved" — that's false: this function either returns its
    // whole object or throws, so ANY unconditional throw anywhere in its body aborts the entire
    // call, denying the shadow `dbPort`/`jwtSecret`/etc. too, regardless of textual position.
    stubEnv("SUPABASE_STUDIO_ENABLED", "not-a-bool");
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
    stubEnv("SUPABASE_STUDIO_ENABLED", "not-a-bool");
    const config = baseConfig({ studio: { enabled: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for studio.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_STUDIO_PORT when a remote block already set studio.port", () => {
    stubEnv("SUPABASE_STUDIO_PORT", "not-a-port");
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
    stubEnv("SUPABASE_LOCAL_SMTP_ENABLED", "not-a-bool");
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
    stubEnv("SUPABASE_LOCAL_SMTP_ENABLED", "not-a-bool");
    const config = baseConfig({ local_smtp: { enabled: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for local_smtp.enabled: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_AUTH_ENABLE_SIGNUP when a remote block already set auth.enable_signup", () => {
    stubEnv("SUPABASE_AUTH_ENABLE_SIGNUP", "not-a-bool");
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
    stubEnv("SUPABASE_AUTH_ENABLE_SIGNUP", "not-a-bool");
    const config = baseConfig({ auth: { enable_signup: false } });
    expect(() => resolveLocalConfigValues(config, "127.0.0.1", WORKDIR)).toThrow(
      'Invalid config for auth.enable_signup: cannot parse "not-a-bool" as a bool',
    );
  });

  it("suppresses a malformed SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH when a remote block already set auth.minimum_password_length", () => {
    stubEnv("SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH", "not-a-number");
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
    stubEnv("SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED", "not-a-bool");
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
    // Regression (review: PRRT_kwDOErm0O86XGTq5): the remote can supply a valid `uri` while a
    // stale/malformed `SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI` sits in the ambient
    // environment. `mergeRemoteConfig` sets EVERY matched-block leaf
    // above `AutomaticEnv`, so the remote's valid uri must win and validation must pass — before
    // this fix, the ungated env read won instead and `legacyValidateResolvedConfig`'s scheme
    // check rejected a linked diff/pull that Go would have accepted.
    stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI", "ftp://example.com");
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
    stubEnv("SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI", "ftp://example.com");
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

describe("legacyResolveLocalJwks", () => {
  const tempRoot = useLegacyTempWorkdir("supabase-local-jwks-test-");
  const resolveJwksEffect = (...args: Parameters<typeof legacyResolveLocalJwks>) =>
    legacyResolveLocalJwks(...args).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          FetchHttpClient.layer,
          Layer.succeed(FetchHttpClient.Fetch, globalThis.fetch),
        ),
      ),
    );

  it.effect(
    "includes the default ES256 signing key and the oct JWT-secret fallback when no signing_keys_path is configured",
    () =>
      Effect.gen(function* () {
        // `a.SigningKeys` defaults to this single ES256 key at `NewConfig()` time,
        // unconditionally — `ResolveJWKS` always publishes it
        // (in public form) unless a configured `signing_keys_path` file overrides it.
        const config = baseConfig();
        const jwks = yield* resolveJwksEffect(
          config,
          tempRoot.current,
          "a".repeat(32),
          testProjectEnvValues,
        );
        expect(decodeJson(jwks)).toEqual({
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
      }),
  );

  it.effect("publishes the public form of every signing key and omits the oct fallback", () =>
    Effect.gen(function* () {
      const jwk = generateRsaJwk();
      yield* writeSigningKeys(tempRoot.current, [jwk]);
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const jwks = yield* resolveJwksEffect(
        config,
        tempRoot.current,
        "a".repeat(32),
        testProjectEnvValues,
      );
      const parsed = decodeJson(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };

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
    }),
  );

  // Go decodes `auth.signing_keys_path` directly into `[]JWK`,
  // so a configured key's `use`/`key_ops`/`ext` metadata must round-trip into the published JWKS
  // via `ToPublicJWK`, which keeps `use`/`ext` verbatim and
  // filters `key_ops` down to `"verify"` entries only (never dropping the other two fields).
  it.effect("preserves a configured signing key's use/ext and filters key_ops to verify-only", () =>
    Effect.gen(function* () {
      const jwk = { ...generateRsaJwk(), use: "sig", ext: true, key_ops: ["sign", "verify"] };
      yield* writeSigningKeys(tempRoot.current, [jwk]);
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const jwks = yield* resolveJwksEffect(
        config,
        tempRoot.current,
        "a".repeat(32),
        testProjectEnvValues,
      );
      const parsed = decodeJson(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };

      expect(parsed.keys[0]).toMatchObject({ use: "sig", ext: true, key_ops: ["verify"] });
    }),
  );

  // Go quirk this reproduces: `a.SigningKeysPath` is resolved to an absolute path
  // unconditionally, but the FILE is only read into
  // `a.SigningKeys` when auth is enabled (`Config.Validate`'s file read is nested inside
  // `if c.Auth.Enabled`) — so a disabled-auth config with a
  // configured `signing_keys_path` never reads the file, and `a.SigningKeys` stays at its
  // unconditional `NewConfig()` default (the single ES256 key) rather than becoming empty.
  // The oct fallback is still skipped (`len(a.SigningKeysPath) == 0` is false), so the
  // default ES256 key is the ONLY entry — neither the file's keys nor the oct key appear.
  it.effect(
    "falls back to the default ES256 signing key (not the configured file, not the oct fallback) when auth is disabled but signing_keys_path is set",
    () =>
      Effect.gen(function* () {
        yield* writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
        const config = baseConfig({
          auth: { enabled: false, signing_keys_path: "signing_keys.json" },
        });
        const jwks = yield* resolveJwksEffect(
          config,
          tempRoot.current,
          "a".repeat(32),
          testProjectEnvValues,
        );
        expect(decodeJson(jwks)).toEqual({
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
      }),
  );

  it.effect("throws a Go-worded error when the signing keys file does not exist", () =>
    Effect.gen(function* () {
      const config = baseConfig({ auth: { signing_keys_path: "missing.json" } });
      const exit = yield* Effect.exit(
        resolveJwksEffect(config, tempRoot.current, "a".repeat(32), testProjectEnvValues),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(exit.cause)).toContain("failed to read signing keys: ");
    }),
  );

  it.effect("throws a Go-worded error when the signing keys file is malformed JSON", () =>
    Effect.gen(function* () {
      const supabaseDir = join(tempRoot.current, "supabase");
      yield* makeDirectoryEffect(supabaseDir);
      yield* writeFileEffect(join(supabaseDir, "signing_keys.json"), "not valid json");
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const exit = yield* Effect.exit(
        resolveJwksEffect(config, tempRoot.current, "a".repeat(32), testProjectEnvValues),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(exit.cause)).toContain("failed to decode signing keys: ");
    }),
  );

  describe("auth.third_party", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.effect("rejects an enabled third-party provider missing its required field", () =>
      Effect.gen(function* () {
        const config = baseConfig({ auth: { third_party: { firebase: { enabled: true } } } });
        const exit = yield* Effect.exit(
          resolveJwksEffect(config, WORKDIR, "a".repeat(32), testProjectEnvValues),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(String(exit.cause)).toContain(
            "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
          );
      }),
    );

    it.effect("rejects more than one enabled third-party provider", () =>
      Effect.gen(function* () {
        const config = baseConfig({
          auth: {
            third_party: {
              firebase: { enabled: true, project_id: "my-project" },
              workos: { enabled: true, issuer_url: "https://issuer.example" },
            },
          },
        });
        const exit = yield* Effect.exit(
          resolveJwksEffect(config, WORKDIR, "a".repeat(32), testProjectEnvValues),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(String(exit.cause)).toContain(
            "Invalid config: Only one third_party provider allowed to be enabled at a time.",
          );
      }),
    );

    it.effect(
      "does not validate third-party providers when auth is disabled, matching Go's ResolveJWKS/IssuerURL",
      () =>
        Effect.gen(function* () {
          // `Auth.ThirdParty.validate()` (the "at most one enabled" check above) only runs
          // inside `Config.Validate`'s `if Auth.Enabled` block — `ResolveJWKS`/`IssuerURL()` is called
          // unconditionally and never validates, it just picks the first enabled provider by fixed
          // priority (firebase, auth0, aws_cognito, clerk, workos) and resolves its remote JWKS.
          const remoteKeys = [{ kty: "RSA", kid: "firebase-key", n: "abc", e: "AQAB" }];
          const issuerUrl = "https://securetoken.google.com/my-project";
          const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
            if (url === `${issuerUrl}/.well-known/openid-configuration`) {
              return Promise.resolve(
                new Response(encodeJson({ jwks_uri: `${issuerUrl}/jwks.json` }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              );
            }
            if (url === `${issuerUrl}/jwks.json`) {
              return Promise.resolve(
                new Response(encodeJson({ keys: remoteKeys }), {
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
          const jwksJson = yield* resolveJwksEffect(
            config,
            WORKDIR,
            "a".repeat(32),
            testProjectEnvValues,
          );
          const jwks = decodeJson(jwksJson) as { keys: ReadonlyArray<{ kid?: string }> };
          expect(jwks.keys.some((key) => key.kid === "firebase-key")).toBe(true);
          fetchMock.mockRestore();
        }),
    );

    // `ResolveJWKS` only attempts the remote fetch when `issuerURL != ""`;
    // workos's own `issuerURL()` is a raw field read
    // with no validation, so an enabled-but-unconfigured workos provider
    // with `auth.enabled = false` resolves an empty issuer URL that Go tolerates by skipping the
    // fetch entirely, rather than attempting (and failing) a fetch against an empty URL.
    it.effect(
      'does not attempt a remote JWKS fetch for an enabled third-party provider with an empty issuer_url, matching Go\'s issuerURL != "" check',
      () =>
        Effect.gen(function* () {
          const fetchMock = vi.spyOn(globalThis, "fetch");
          const config = baseConfig({
            auth: {
              enabled: false,
              third_party: { workos: { enabled: true, issuer_url: "" } },
            },
          });

          const jwksJson = yield* resolveJwksEffect(
            config,
            WORKDIR,
            "a".repeat(32),
            testProjectEnvValues,
          );
          const jwks = decodeJson(jwksJson) as { keys: ReadonlyArray<unknown> };

          expect(fetchMock).not.toHaveBeenCalled();
          expect(jwks.keys.length).toBeGreaterThan(0);
          fetchMock.mockRestore();
        }),
    );

    it.effect("fetches and includes the remote JWKS for an enabled third-party provider", () =>
      Effect.gen(function* () {
        const remoteKeys = [
          {
            kty: "RSA",
            kid: "remote-key",
            n: "abc",
            e: "AQAB",
            x5c: ["certificate-chain-entry"],
            custom_extension: "preserve-me",
          },
        ];
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url === "https://issuer.example/.well-known/openid-configuration") {
            return Promise.resolve(
              new Response(encodeJson({ jwks_uri: "https://issuer.example/jwks.json" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          if (url === "https://issuer.example/jwks.json") {
            return Promise.resolve(
              new Response(encodeJson({ keys: remoteKeys }), {
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
        const jwks = yield* resolveJwksEffect(
          config,
          WORKDIR,
          "a".repeat(32),
          testProjectEnvValues,
        );
        const parsed = decodeJson(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };

        expect(parsed.keys).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kid: "remote-key",
              x5c: ["certificate-chain-entry"],
              custom_extension: "preserve-me",
            }),
          ]),
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }),
    );

    // The key divergence from `shared/functions/serve.ts`'s own (unrelated)
    // `finalizeAuthArtifacts`: `start` treats a remote-JWKS fetch failure as a hard,
    // command-failing error — `legacyResolveLocalJwks`
    // must propagate it too, not swallow it and continue with zero remote keys.
    it.effect(
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
          const exit = yield* Effect.exit(
            resolveJwksEffect(config, WORKDIR, "a".repeat(32), testProjectEnvValues),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("oidc discovery failed");
        }),
    );
  });

  describe("remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
    // `mergeRemoteConfig` installs every matched `[remotes.<ref>]` leaf at viper's OVERRIDE
    // tier, above `AutomaticEnv` — regression
    // coverage for review PRRT_kwDOErm0O86W3Ox_, which found `auth.signing_keys_path`/
    // `auth.third_party.*` reapplying a conflicting `SUPABASE_AUTH_*` env value even after a
    // matched remote block set them.
    afterEach(() => {
      for (const name of [
        "SUPABASE_AUTH_SIGNING_KEYS_PATH",
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED",
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL",
        "SUPABASE_AUTH_ENABLED",
      ]) {
        stubEnv(name, undefined);
      }
    });

    it.effect(
      "prefers a remote-set auth.signing_keys_path over a conflicting SUPABASE_AUTH_SIGNING_KEYS_PATH",
      () =>
        Effect.gen(function* () {
          yield* writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
          stubEnv("SUPABASE_AUTH_SIGNING_KEYS_PATH", "missing-file.json");
          const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
          const jwks = yield* resolveJwksEffect(
            config,
            tempRoot.current,
            "a".repeat(32),
            testProjectEnvValues,
            new Set(["auth.signing_keys_path"]),
          );
          const parsed = decodeJson(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };
          expect(parsed.keys).toHaveLength(1);
          expect(parsed.keys[0]).toMatchObject({ kty: "RSA", kid: "test-rsa-kid" });
        }),
    );

    it.effect(
      "still rejects a missing SUPABASE_AUTH_SIGNING_KEYS_PATH override when no remote block matched",
      () =>
        Effect.gen(function* () {
          yield* writeSigningKeys(tempRoot.current, [generateRsaJwk()]);
          stubEnv("SUPABASE_AUTH_SIGNING_KEYS_PATH", "missing-file.json");
          const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
          const exit = yield* Effect.exit(
            resolveJwksEffect(config, tempRoot.current, "a".repeat(32), testProjectEnvValues),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(String(exit.cause)).toContain("failed to read signing keys: ");
        }),
    );

    it.effect("prefers a remote-set auth.third_party.workos.* over conflicting env overrides", () =>
      Effect.gen(function* () {
        const remoteKeys = [{ kty: "RSA", kid: "remote-key", n: "abc", e: "AQAB" }];
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url === "https://remote-issuer.example/.well-known/openid-configuration") {
            return Promise.resolve(
              new Response(encodeJson({ jwks_uri: "https://remote-issuer.example/jwks.json" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          if (url === "https://remote-issuer.example/jwks.json") {
            return Promise.resolve(
              new Response(encodeJson({ keys: remoteKeys }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }
          return Promise.reject(new Error(`unexpected fetch url: ${url}`));
        });
        stubEnv("SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED", "false");
        stubEnv("SUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL", "https://env-should-not-win.test");
        const config = baseConfig({
          auth: {
            third_party: { workos: { enabled: true, issuer_url: "https://remote-issuer.example" } },
          },
        });
        const jwks = yield* resolveJwksEffect(
          config,
          WORKDIR,
          "a".repeat(32),
          testProjectEnvValues,
          new Set(["auth.third_party.workos.enabled", "auth.third_party.workos.issuer_url"]),
        );
        const parsed = decodeJson(jwks) as { keys: ReadonlyArray<Record<string, unknown>> };
        expect(parsed.keys.some((key) => key["kid"] === "remote-key")).toBe(true);
        fetchMock.mockRestore();
      }),
    );

    it.effect(
      "suppresses a malformed SUPABASE_AUTH_ENABLED when a remote block already set auth.enabled",
      () =>
        Effect.gen(function* () {
          // Regression (review: PRRT_kwDOErm0O86W30n6): this function recomputes `authEnabled`
          // itself (see its own doc comment) to gate `resolveThirdPartyIssuerUrl`'s throwing validate
          // path — before this fix, the ungated `legacyEnvOverrideBool` call still decoded a
          // conflicting env var unconditionally, so a malformed value the remote block should have
          // made irrelevant failed the shadow's PG15+ one-shot auth-migration job outright.
          stubEnv("SUPABASE_AUTH_ENABLED", "not-a-bool");
          const config = baseConfig({ auth: { enabled: false } });
          const value = yield* resolveJwksEffect(
            config,
            WORKDIR,
            "a".repeat(32),
            testProjectEnvValues,
            new Set(["auth.enabled"]),
          );
          expect(value).toEqual(expect.any(String));
        }),
    );

    it.effect("still rejects a malformed SUPABASE_AUTH_ENABLED when no remote block matched", () =>
      Effect.gen(function* () {
        stubEnv("SUPABASE_AUTH_ENABLED", "not-a-bool");
        const config = baseConfig({ auth: { enabled: false } });
        const exit = yield* Effect.exit(
          resolveJwksEffect(config, WORKDIR, "a".repeat(32), testProjectEnvValues),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(String(exit.cause)).toContain(
            'Invalid config for auth.enabled: cannot parse "not-a-bool" as a bool',
          );
      }),
    );
  });
});

describe("legacyResolveAuthExternalUrl — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
  afterEach(() => {
    stubEnv("SUPABASE_AUTH_EXTERNAL_URL", undefined);
  });

  it("prefers a remote-set auth.external_url over a conflicting SUPABASE_AUTH_EXTERNAL_URL", () => {
    stubEnv("SUPABASE_AUTH_EXTERNAL_URL", "https://env-should-not-win.test");
    const document = { auth: { external_url: "https://remote.test" } };
    expect(
      legacyResolveAuthExternalUrl(document, testProjectEnvValues, new Set(["auth.external_url"])),
    ).toBe("https://remote.test");
  });

  it("still applies SUPABASE_AUTH_EXTERNAL_URL when no remote block matched", () => {
    stubEnv("SUPABASE_AUTH_EXTERNAL_URL", "https://env-wins.test");
    const document = { auth: { external_url: "https://configured.test" } };
    expect(legacyResolveAuthExternalUrl(document, testProjectEnvValues)).toBe(
      "https://env-wins.test",
    );
  });
});

describe("legacyResolveConfiguredSigningKeys — remoteOverrideKeys (linked shadow provisioning, CLI-1956)", () => {
  const tempRoot = useLegacyTempWorkdir("supabase-configured-signing-keys-test-");
  const resolveConfiguredSigningKeysEffect = (
    ...args: Parameters<typeof legacyResolveConfiguredSigningKeys>
  ) => legacyResolveConfiguredSigningKeys(...args).pipe(Effect.provide(BunServices.layer));

  afterEach(() => {
    stubEnv("SUPABASE_AUTH_SIGNING_KEYS_PATH", undefined);
    stubEnv("SUPABASE_AUTH_ENABLED", undefined);
  });

  it.effect(
    "prefers a remote-set auth.signing_keys_path over a conflicting SUPABASE_AUTH_SIGNING_KEYS_PATH",
    () =>
      Effect.gen(function* () {
        const jwk = generateRsaJwk();
        yield* writeSigningKeys(tempRoot.current, [jwk]);
        stubEnv("SUPABASE_AUTH_SIGNING_KEYS_PATH", "missing-file.json");
        const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
        const keys = yield* resolveConfiguredSigningKeysEffect(
          config,
          tempRoot.current,
          testProjectEnvValues,
          new Set(["auth.signing_keys_path"]),
        );
        expect(keys).toHaveLength(1);
        expect(keys?.[0]).toMatchObject({ kid: "test-rsa-kid" });
      }),
  );

  it.effect("still reads the env-overridden path when no remote block matched", () =>
    Effect.gen(function* () {
      const jwk = generateRsaJwk();
      yield* writeSigningKeys(tempRoot.current, [jwk]);
      stubEnv("SUPABASE_AUTH_SIGNING_KEYS_PATH", "missing-file.json");
      const config = baseConfig({ auth: { signing_keys_path: "signing_keys.json" } });
      const exit = yield* Effect.exit(
        resolveConfiguredSigningKeysEffect(config, tempRoot.current, testProjectEnvValues),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(exit.cause)).toContain("failed to read signing keys: ");
    }),
  );

  it.effect(
    "suppresses a malformed SUPABASE_AUTH_ENABLED when a remote block already set auth.enabled",
    () =>
      Effect.gen(function* () {
        // Regression (review: PRRT_kwDOErm0O86W30n6): this function's own `authEnabled` recompute
        // (see its doc comment) used to be ungated, so a malformed override the remote block should
        // have made irrelevant aborted the anon/service_role asymmetric-signing path outright.
        stubEnv("SUPABASE_AUTH_ENABLED", "not-a-bool");
        const config = baseConfig({ auth: { enabled: false } });
        yield* resolveConfiguredSigningKeysEffect(
          config,
          tempRoot.current,
          testProjectEnvValues,
          new Set(["auth.enabled"]),
        );
      }),
  );

  it.effect("still rejects a malformed SUPABASE_AUTH_ENABLED when no remote block matched", () =>
    Effect.gen(function* () {
      stubEnv("SUPABASE_AUTH_ENABLED", "not-a-bool");
      const config = baseConfig({ auth: { enabled: false } });
      const exit = yield* Effect.exit(
        resolveConfiguredSigningKeysEffect(config, tempRoot.current, testProjectEnvValues),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(exit.cause)).toContain(
          'Invalid config for auth.enabled: cannot parse "not-a-bool" as a bool',
        );
    }),
  );
});
