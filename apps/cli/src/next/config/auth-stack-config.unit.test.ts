import { ProjectConfigSchema } from "@supabase/config";
import { Effect, Schema } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { translateAuthStackConfig } from "./auth-stack-config.ts";

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

function projectEnvironment(values: Readonly<Record<string, string>>) {
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

describe("translateAuthStackConfig", () => {
  it("translates signup, email, SMS, providers, redirects, hooks, and credentials", async () => {
    const result = await Effect.runPromise(
      translateAuthStackConfig({
        configDir: "/project/supabase",
        authEnabled: true,
        projectEnvironment: null,
        rawDocument: {
          auth: {
            email: { smtp: {} },
            sms: { twilio: {} },
            external: { github: {} },
            hook: { custom_access_token: {} },
          },
        },
        projectConfig: decodeProjectConfig({
          auth: {
            site_url: "https://app.example.com",
            additional_redirect_urls: ["https://app.example.com/callback"],
            jwt_expiry: 7200,
            jwt_issuer: "https://api.example.com/auth/v1",
            enable_signup: false,
            jwt_secret: "symmetric-secret-with-at-least-32-characters",
            publishable_key: "sb_publishable_override",
            secret_key: "sb_secret_override",
            email: {
              enable_signup: false,
              enable_confirmations: true,
              smtp: {
                enabled: true,
                host: "smtp.example.com",
                port: 587,
                user: "mailer",
                pass: "smtp-password",
                admin_email: "admin@example.com",
              },
            },
            sms: {
              enable_signup: true,
              twilio: {
                enabled: true,
                account_sid: "account",
                message_service_sid: "service",
                auth_token: "sms-token",
              },
            },
            external: {
              github: {
                enabled: true,
                client_id: "github-client",
                secret: "github-secret",
              },
            },
            hook: {
              custom_access_token: {
                enabled: true,
                uri: "pg-functions://postgres/auth/custom-access-token",
                secrets: "hook-secret",
              },
            },
          },
        }),
      }),
    );

    expect(result.credentials).toMatchObject({
      signing: {
        _tag: "SymmetricJwtSecret",
        secret: "symmetric-secret-with-at-least-32-characters",
      },
      publishableKey: "sb_publishable_override",
      secretKey: "sb_secret_override",
    });
    expect(result.auth).toMatchObject({
      siteUrl: "https://app.example.com",
      additionalRedirectUrls: ["https://app.example.com/callback"],
      jwtExpiry: 7200,
      jwtIssuer: "https://api.example.com/auth/v1",
      enableSignup: false,
      email: {
        enableSignup: false,
        enableConfirmations: true,
        smtp: { host: "smtp.example.com", pass: "smtp-password" },
      },
      sms: {
        enableSignup: true,
        provider: { _tag: "twilio", authToken: "sms-token" },
      },
      externalProviders: {
        github: { enabled: true, clientId: "github-client", secret: "github-secret" },
      },
      hooks: {
        custom_access_token: { enabled: true, secrets: "hook-secret" },
      },
    });
  });

  it("loads asymmetric signing keys relative to config.toml without exposing them in errors", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "auth-stack-config-"));
    try {
      await writeFile(
        join(configDir, "signing-keys.json"),
        JSON.stringify([
          {
            kty: "EC",
            kid: "local-auth-test",
            alg: "ES256",
            crv: "P-256",
            x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
            y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
            d: "dIhR8wywJlqlua4y_yMq2SLhlFXDZJBCvFrY1DCHyVU",
          },
        ]),
      );
      const result = await Effect.runPromise(
        translateAuthStackConfig({
          configDir,
          authEnabled: true,
          projectEnvironment: projectEnvironment({
            SUPABASE_AUTH_SIGNING_KEYS_PATH: "signing-keys.json",
          }),
          projectConfig: decodeProjectConfig({
            auth: { signing_keys_path: "ignored.json" },
          }),
        }),
      );
      expect(result.credentials.signing).toMatchObject({
        _tag: "AsymmetricJwtKeys",
        keys: [expect.objectContaining({ kid: "local-auth-test" })],
      });

      await writeFile(
        join(configDir, "signing-keys.json"),
        JSON.stringify([
          {
            kty: "RSA",
            kid: "mismatched-key",
            alg: "ES256",
            crv: "P-256",
            x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
            y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
            d: "private-signing-material",
          },
        ]),
      );
      const exit = await Effect.runPromise(
        translateAuthStackConfig({
          configDir,
          authEnabled: true,
          projectEnvironment: null,
          projectConfig: decodeProjectConfig({
            auth: { signing_keys_path: "signing-keys.json" },
          }),
        }).pipe(Effect.exit),
      );
      expect(JSON.stringify(exit)).toContain("auth.signing_keys_path");
      expect(JSON.stringify(exit)).not.toContain("private-signing-material");
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("applies typed Auth environment overrides without retaining secret values", async () => {
    const result = await Effect.runPromise(
      translateAuthStackConfig({
        configDir: "/project/supabase",
        authEnabled: true,
        rawDocument: { auth: { external: { github: {} } } },
        projectEnvironment: projectEnvironment({
          SUPABASE_AUTH_ENABLE_SIGNUP: "false",
          SUPABASE_AUTH_JWT_EXPIRY: "7200",
          SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS: "https://one.example,https://two.example",
          SUPABASE_AUTH_JWT_SECRET: "env(AUTH_SIGNING_SECRET)",
          AUTH_SIGNING_SECRET: "environment-jwt-secret-with-32-characters",
          SUPABASE_AUTH_EXTERNAL_GITHUB_ENABLED: "true",
          SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID: "environment-client",
          SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET: "env(GITHUB_SECRET)",
          GITHUB_SECRET: "environment-provider-secret",
        }),
        projectConfig: decodeProjectConfig({}),
      }),
    );

    expect(result.credentials.signing).toEqual({
      _tag: "SymmetricJwtSecret",
      secret: "environment-jwt-secret-with-32-characters",
    });
    expect(result.auth).toMatchObject({
      enableSignup: false,
      jwtExpiry: 7200,
      additionalRedirectUrls: ["https://one.example", "https://two.example"],
      externalProviders: {
        github: {
          enabled: true,
          clientId: "environment-client",
          secret: "environment-provider-secret",
        },
      },
    });
  });

  it("reports malformed Auth overrides by path without their values", async () => {
    const exit = await Effect.runPromise(
      translateAuthStackConfig({
        configDir: "/project/supabase",
        authEnabled: true,
        projectEnvironment: projectEnvironment({
          SUPABASE_AUTH_ENABLE_SIGNUP: "private-invalid-boolean",
        }),
        projectConfig: decodeProjectConfig({}),
      }).pipe(Effect.exit),
    );

    expect(JSON.stringify(exit)).toContain("auth.enable_signup");
    expect(JSON.stringify(exit)).not.toContain("private-invalid-boolean");
  });

  it("applies env-only overrides only for sections registered by the legacy defaults", async () => {
    const result = await Effect.runPromise(
      translateAuthStackConfig({
        configDir: "/project/supabase",
        authEnabled: true,
        projectEnvironment: projectEnvironment({
          // Apple and Twilio are emitted by the legacy default template, so Viper registers them.
          SUPABASE_AUTH_EXTERNAL_APPLE_ENABLED: "true",
          SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID: "apple-client",
          // Hook structs are pointers and remain unregistered until their TOML section exists.
          SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED: "true",
          SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI: "pg-functions://postgres/auth/hook",
        }),
        projectConfig: decodeProjectConfig({}),
      }),
    );

    expect(result.auth).toMatchObject({
      externalProviders: { apple: { enabled: true, clientId: "apple-client" } },
      hooks: { custom_access_token: { enabled: false } },
    });
  });

  it("does not read signing keys when Auth is excluded", async () => {
    const result = await Effect.runPromise(
      translateAuthStackConfig({
        configDir: "/missing",
        authEnabled: false,
        projectEnvironment: null,
        projectConfig: decodeProjectConfig({
          auth: { signing_keys_path: "missing.json" },
        }),
      }),
    );

    expect(result.auth).toBe(false);
    expect(result.credentials.signing?._tag).toBe("SymmetricJwtSecret");
  });
});
