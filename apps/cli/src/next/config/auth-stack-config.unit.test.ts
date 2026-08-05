import { type LoadedProjectConfig, ProjectConfigSchema } from "@supabase/config";
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

function translateAuth(input: {
  readonly configDir: string;
  readonly authEnabled: boolean;
  readonly projectEnvironment: ReturnType<typeof projectEnvironment> | null;
  readonly projectConfig: LoadedProjectConfig["config"];
  readonly rawDocument?: Readonly<Record<string, unknown>>;
  readonly appliedRemote?: string;
  readonly remoteOverridePaths?: ReadonlyArray<string>;
}) {
  const { rawDocument, appliedRemote, remoteOverridePaths, ...rest } = input;
  const loadedProjectConfig: LoadedProjectConfig | null =
    rawDocument === undefined && appliedRemote === undefined
      ? null
      : {
          path: join(input.configDir, "config.toml"),
          format: "toml",
          config: input.projectConfig,
          ignoredPaths: [],
          document: rawDocument === undefined ? undefined : { ...rawDocument },
          appliedRemote,
          remoteOverridePaths,
        };
  return translateAuthStackConfig({ ...rest, loadedProjectConfig });
}

describe("translateAuthStackConfig", () => {
  it("translates signup, email, SMS, providers, redirects, hooks, and credentials", async () => {
    const result = await Effect.runPromise(
      translateAuth({
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
        translateAuth({
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
        translateAuth({
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
      translateAuth({
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

  it("keeps remote Auth credentials and runtime fields above environment bindings", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "auth-stack-config-remote-"));
    try {
      await writeFile(
        join(configDir, "remote-signing-keys.json"),
        JSON.stringify([
          {
            kty: "EC",
            kid: "remote-signing-key",
            alg: "ES256",
            crv: "P-256",
            x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
            y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
            d: "dIhR8wywJlqlua4y_yMq2SLhlFXDZJBCvFrY1DCHyVU",
          },
        ]),
      );
      const projectConfig = decodeProjectConfig({
        auth: {
          jwt_secret: "remote-legacy-secret-with-at-least-32-chars",
          signing_keys_path: "remote-signing-keys.json",
          publishable_key: "remote-publishable",
          site_url: "https://remote.example",
          additional_redirect_urls: ["https://remote.example/callback"],
          enable_signup: false,
          email: {
            enable_signup: false,
            max_frequency: "remote-email-frequency",
            smtp: {
              enabled: true,
              host: "remote.smtp.example",
              port: 2525,
              user: "remote-user",
              pass: "remote-pass",
              admin_email: "remote@example.com",
            },
          },
          sms: {
            enable_signup: false,
            template: "remote-template",
            test_otp: { "15555550123": "123456" },
            twilio: {
              enabled: true,
              account_sid: "remote-account",
              message_service_sid: "remote-service",
              auth_token: "remote-token",
            },
          },
          external: {
            github: {
              enabled: true,
              client_id: "remote-client",
              secret: "remote-provider-secret",
            },
          },
          hook: {
            custom_access_token: {
              enabled: true,
              uri: "pg-functions://postgres/auth/remote-hook",
              secrets: "remote-hook-secret",
            },
          },
        },
      });
      const remoteOverridePaths = [
        "auth.jwt_secret",
        "auth.signing_keys_path",
        "auth.publishable_key",
        "auth.site_url",
        "auth.additional_redirect_urls",
        "auth.enable_signup",
        "auth.email.enable_signup",
        "auth.email.max_frequency",
        "auth.email.smtp.enabled",
        "auth.email.smtp.host",
        "auth.email.smtp.port",
        "auth.email.smtp.user",
        "auth.email.smtp.pass",
        "auth.email.smtp.admin_email",
        "auth.sms.enable_signup",
        "auth.sms.template",
        "auth.sms.test_otp",
        "auth.sms.twilio.enabled",
        "auth.sms.twilio.account_sid",
        "auth.sms.twilio.message_service_sid",
        "auth.sms.twilio.auth_token",
        "auth.external.github.enabled",
        "auth.external.github.client_id",
        "auth.external.github.secret",
        "auth.hook.custom_access_token.enabled",
        "auth.hook.custom_access_token.uri",
        "auth.hook.custom_access_token.secrets",
      ];
      const result = await Effect.runPromise(
        translateAuth({
          configDir,
          authEnabled: true,
          appliedRemote: "preview",
          remoteOverridePaths,
          rawDocument: {
            auth: {
              email: { smtp: { enabled: true } },
              sms: { twilio: {} },
              external: { github: {} },
              hook: { custom_access_token: {} },
            },
          },
          projectEnvironment: projectEnvironment({
            SUPABASE_AUTH_JWT_SECRET: "environment-secret-with-at-least-32-chars",
            SUPABASE_AUTH_SIGNING_KEYS_PATH: "missing-environment-keys.json",
            SUPABASE_AUTH_PUBLISHABLE_KEY: "environment-publishable",
            SUPABASE_AUTH_SITE_URL: "https://environment.example",
            SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS: "https://environment.example/callback",
            SUPABASE_AUTH_ENABLE_SIGNUP: "true",
            SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP: "true",
            SUPABASE_AUTH_EMAIL_MAX_FREQUENCY: "environment-email-frequency",
            SUPABASE_AUTH_EMAIL_SMTP_ENABLED: "false",
            SUPABASE_AUTH_EMAIL_SMTP_HOST: "environment.smtp.example",
            SUPABASE_AUTH_EMAIL_SMTP_PORT: "1025",
            SUPABASE_AUTH_EMAIL_SMTP_USER: "environment-user",
            SUPABASE_AUTH_EMAIL_SMTP_PASS: "environment-pass",
            SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL: "environment@example.com",
            SUPABASE_AUTH_SMS_ENABLE_SIGNUP: "true",
            SUPABASE_AUTH_SMS_TEMPLATE: "environment-template",
            SUPABASE_AUTH_SMS_TEST_OTP: "environment-map-cannot-decode",
            SUPABASE_AUTH_SMS_TWILIO_ENABLED: "false",
            SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID: "environment-account",
            SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID: "environment-service",
            SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN: "environment-token",
            SUPABASE_AUTH_EXTERNAL_GITHUB_ENABLED: "false",
            SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID: "environment-client",
            SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET: "environment-provider-secret",
            SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED: "false",
            SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI:
              "pg-functions://postgres/auth/environment-hook",
            SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS: "environment-hook-secret",
          }),
          projectConfig,
        }),
      );

      expect(result.credentials).toMatchObject({
        signing: {
          _tag: "AsymmetricJwtKeys",
          keys: [expect.objectContaining({ kid: "remote-signing-key" })],
          legacySecret: "remote-legacy-secret-with-at-least-32-chars",
        },
        publishableKey: "remote-publishable",
      });
      expect(result.auth).toMatchObject({
        siteUrl: "https://remote.example",
        additionalRedirectUrls: ["https://remote.example/callback"],
        enableSignup: false,
        email: {
          enableSignup: false,
          maxFrequency: "remote-email-frequency",
          smtp: {
            host: "remote.smtp.example",
            port: 2525,
            user: "remote-user",
            pass: "remote-pass",
            adminEmail: "remote@example.com",
          },
        },
        sms: {
          enableSignup: false,
          template: "remote-template",
          testOtp: { "15555550123": "123456" },
          provider: {
            _tag: "twilio",
            accountSid: "remote-account",
            messageServiceSid: "remote-service",
            authToken: "remote-token",
          },
        },
        externalProviders: {
          github: { enabled: true, clientId: "remote-client", secret: "remote-provider-secret" },
        },
        hooks: {
          custom_access_token: {
            enabled: true,
            uri: "pg-functions://postgres/auth/remote-hook",
            secrets: "remote-hook-secret",
          },
        },
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("rejects an environment string for the Auth SMS test OTP map", async () => {
    const exit = await Effect.runPromise(
      translateAuth({
        configDir: "/project/supabase",
        authEnabled: true,
        projectEnvironment: projectEnvironment({
          SUPABASE_AUTH_SMS_TEST_OTP: "15555550123:123456",
        }),
        projectConfig: decodeProjectConfig({}),
      }).pipe(Effect.exit),
    );

    expect(JSON.stringify(exit)).toContain("auth.sms.test_otp");
    expect(JSON.stringify(exit)).not.toContain("15555550123:123456");
  });

  it("reports malformed Auth overrides by path without their values", async () => {
    const exit = await Effect.runPromise(
      translateAuth({
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
      translateAuth({
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

  it("validates signing keys even when Auth is excluded", async () => {
    await expect(
      Effect.runPromise(
        translateAuth({
          configDir: "/missing",
          authEnabled: false,
          projectEnvironment: null,
          projectConfig: decodeProjectConfig({
            auth: { signing_keys_path: "missing.json" },
          }),
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "AuthStackConfigError",
      path: "auth.signing_keys_path",
    });
  });
});
