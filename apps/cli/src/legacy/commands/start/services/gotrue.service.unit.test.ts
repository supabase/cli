import { describe, expect, test } from "vitest";

import {
  legacyBuildGotrueContainerSpec,
  legacyBuildGotrueEnv,
  legacyFormatMapForEnvConfig,
  type LegacyBuildGotrueEnvInput,
  type LegacyGotrueExternalProviderInput,
  type LegacyGotrueHookInput,
  type LegacyGotrueSigningKey,
  type LegacyGotrueWebauthnInput,
} from "./gotrue.service.ts";

// Every field not asserted by a specific subtest below reflects the
// default config's own values.
const baseEnvInput: LegacyBuildGotrueEnvInput = {
  dbHost: "db",
  dbPassword: "postgres",
  apiUrl: "http://127.0.0.1:54321",
  jwtSecret: "test-jwt-secret",
  jwtIssuer: undefined,
  jwtExpiry: 3600,
  siteUrl: "http://127.0.0.1:3000",
  additionalRedirectUrls: ["https://127.0.0.1:3000"],
  enableSignup: true,
  enableAnonymousSignIns: false,
  enableRefreshTokenRotation: true,
  refreshTokenReuseInterval: 10,
  enableManualLinking: false,
  minimumPasswordLength: 6,
  passwordRequirements: "",
  email: {
    enable_signup: true,
    double_confirm_changes: true,
    enable_confirmations: false,
    secure_password_change: false,
    max_frequency: "1s",
    otp_length: 6,
    otp_expiry: 3600,
    template: {},
    notification: {},
  },
  kongContainerName: "test-kong",
  sms: {
    enable_signup: false,
    enable_confirmations: false,
    template: "Your code is {{ .Code }}",
    max_frequency: "5s",
    twilio: { enabled: false, account_sid: "", message_service_sid: "" },
    twilio_verify: { enabled: false },
    messagebird: { enabled: false },
    textlocal: { enabled: false },
    vonage: { enabled: false },
  },
  sessions: undefined,
  mfa: {
    totp: { enroll_enabled: false, verify_enabled: false },
    phone: {
      enroll_enabled: false,
      verify_enabled: false,
      otp_length: 6,
      template: "Your code is {{ .Code }}",
      max_frequency: "5s",
    },
    web_authn: { enroll_enabled: false, verify_enabled: false },
    max_enrolled_factors: 10,
  },
  rateLimit: {
    anonymous_users: 30,
    token_refresh: 150,
    sign_in_sign_ups: 30,
    token_verifications: 30,
    email_sent: 2,
    sms_sent: 30,
    web3: 30,
  },
  web3: { solana: { enabled: false }, ethereum: { enabled: false } },
  oauthServer: {
    enabled: false,
    authorization_url_path: "/oauth/consent",
    allow_dynamic_registration: false,
  },
  hooks: {
    mfaVerificationAttempt: { enabled: false },
    passwordVerificationAttempt: { enabled: false },
    customAccessToken: { enabled: false },
    sendSms: { enabled: false },
    sendEmail: { enabled: false },
    beforeUserCreated: { enabled: false },
  },
  externalProviders: {},
};

describe("legacyBuildGotrueEnv", () => {
  // Port of TestBuildGotrueEnv's 4 sub-cases (start_test.go:440-520).
  describe("TestBuildGotrueEnv parity", () => {
    test("uses auth scoped external url and absolute mailer verify urls", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        apiUrl: "http://127.0.0.1:54321",
        jwtIssuer: undefined,
        siteUrl: "http://127.0.0.1:3000",
        externalProviders: {
          github: {
            enabled: true,
            clientId: "client-id",
            secret: "secret",
            url: "",
            skipNonceCheck: false,
            emailOptional: false,
          },
        },
      });

      expect(env["API_EXTERNAL_URL"]).toBe("http://127.0.0.1:54321/auth/v1");
      expect(env["GOTRUE_JWT_ISSUER"]).toBe("http://127.0.0.1:54321/auth/v1");
      expect(env["GOTRUE_MAILER_URLPATHS_INVITE"]).toBe("http://127.0.0.1:54321/auth/v1/verify");
      expect(env["GOTRUE_MAILER_URLPATHS_CONFIRMATION"]).toBe(
        "http://127.0.0.1:54321/auth/v1/verify",
      );
      expect(env["GOTRUE_MAILER_URLPATHS_RECOVERY"]).toBe("http://127.0.0.1:54321/auth/v1/verify");
      expect(env["GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE"]).toBe(
        "http://127.0.0.1:54321/auth/v1/verify",
      );
      expect(env["GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI"]).toBe(
        "http://127.0.0.1:54321/auth/v1/callback",
      );
    });

    test("honors an explicit auth.external_url override for API_EXTERNAL_URL, the JWT issuer default, the mailer verify URL, and OAuth redirects", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        apiUrl: "http://127.0.0.1:54321",
        authExternalUrl: "https://auth.example.com",
        jwtIssuer: undefined,
        siteUrl: "http://127.0.0.1:3000",
        externalProviders: {
          github: {
            enabled: true,
            clientId: "client-id",
            secret: "secret",
            url: "",
            skipNonceCheck: false,
            emailOptional: false,
          },
        },
      });

      expect(env["API_EXTERNAL_URL"]).toBe("https://auth.example.com");
      expect(env["GOTRUE_JWT_ISSUER"]).toBe("https://auth.example.com");
      expect(env["GOTRUE_MAILER_URLPATHS_INVITE"]).toBe("https://auth.example.com/verify");
      expect(env["GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI"]).toBe("https://auth.example.com/callback");
    });

    test("preserves explicit provider redirect override", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        apiUrl: "http://127.0.0.1:54321",
        jwtIssuer: "https://issuer.example.com/auth/v1",
        siteUrl: "http://127.0.0.1:3000",
        externalProviders: {
          azure: {
            enabled: true,
            clientId: "",
            url: "",
            redirectUri: "https://example.com/custom/callback",
            skipNonceCheck: false,
            emailOptional: false,
          },
        },
      });

      expect(env["API_EXTERNAL_URL"]).toBe("http://127.0.0.1:54321/auth/v1");
      expect(env["GOTRUE_JWT_ISSUER"]).toBe("https://issuer.example.com/auth/v1");
      expect(env["GOTRUE_MAILER_URLPATHS_INVITE"]).toBe("http://127.0.0.1:54321/auth/v1/verify");
      expect(env["GOTRUE_EXTERNAL_AZURE_REDIRECT_URI"]).toBe("https://example.com/custom/callback");
    });

    test("wires passkey and webauthn settings", () => {
      const webauthn: LegacyGotrueWebauthnInput = {
        rpId: "localhost",
        rpDisplayName: "Supabase",
        rpOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
      };
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        passkeyEnabled: true,
        webauthn,
      });

      expect(env["GOTRUE_PASSKEY_ENABLED"]).toBe("true");
      expect(env["GOTRUE_WEBAUTHN_RP_ID"]).toBe("localhost");
      expect(env["GOTRUE_WEBAUTHN_RP_DISPLAY_NAME"]).toBe("Supabase");
      expect(env["GOTRUE_WEBAUTHN_RP_ORIGINS"]).toBe("http://127.0.0.1:5173,http://localhost:5173");
    });

    test("omits passkey and webauthn env when sections are unset", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        passkeyEnabled: undefined,
        webauthn: undefined,
      });

      expect(env["GOTRUE_PASSKEY_ENABLED"]).toBeUndefined();
      expect(env["GOTRUE_WEBAUTHN_RP_ID"]).toBeUndefined();
    });
  });

  // Port of TestFormatMapForEnvConfig (start_test.go:566-612), exercised
  // through GOTRUE_SMS_TEST_OTP since `formatMapForEnvConfig` is only ever
  // called from inside `buildGotrueEnv`.
  describe("GOTRUE_SMS_TEST_OTP / formatMapForEnvConfig parity", () => {
    test("legacyFormatMapForEnvConfig produces key:value pairs with no trailing comma", () => {
      expect(legacyFormatMapForEnvConfig({})).toBe("");
      expect(legacyFormatMapForEnvConfig({ "123456": "123456" })).toMatch(/^\w{6}:\w{6}$/);
      expect(legacyFormatMapForEnvConfig({ "123456": "123456", "234567": "234567" })).toMatch(
        /^\w{6}:\w{6},\w{6}:\w{6}$/,
      );
    });

    test("defaults GOTRUE_SMS_TEST_OTP to an empty string when auth.sms.test_otp is unset", () => {
      const env = legacyBuildGotrueEnv({ ...baseEnvInput, sms: { ...baseEnvInput.sms } });
      expect(env["GOTRUE_SMS_TEST_OTP"]).toBe("");
    });

    test("formats a single-entry auth.sms.test_otp map", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        sms: { ...baseEnvInput.sms, test_otp: { "5555555555": "123456" } },
      });
      expect(env["GOTRUE_SMS_TEST_OTP"]).toBe("5555555555:123456");
    });

    test("formats a multi-entry auth.sms.test_otp map with commas and no trailing comma", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        sms: {
          ...baseEnvInput.sms,
          test_otp: { "5555555555": "123456", "4444444444": "654321" },
        },
      });
      expect(env["GOTRUE_SMS_TEST_OTP"]).not.toMatch(/,$/);
      expect(env["GOTRUE_SMS_TEST_OTP"]?.split(",").sort()).toEqual(
        ["5555555555:123456", "4444444444:654321"].sort(),
      );
    });
  });

  describe("external OAuth providers", () => {
    test("a simple enabled provider (github) emits the full env set, with URL omitted when unset", () => {
      const github: LegacyGotrueExternalProviderInput = {
        enabled: true,
        clientId: "gh-client-id",
        secret: "gh-secret",
        url: "",
        skipNonceCheck: false,
        emailOptional: true,
      };
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        externalProviders: { github },
      });

      expect(env["GOTRUE_EXTERNAL_GITHUB_ENABLED"]).toBe("true");
      expect(env["GOTRUE_EXTERNAL_GITHUB_CLIENT_ID"]).toBe("gh-client-id");
      expect(env["GOTRUE_EXTERNAL_GITHUB_SECRET"]).toBe("gh-secret");
      expect(env["GOTRUE_EXTERNAL_GITHUB_SKIP_NONCE_CHECK"]).toBe("false");
      expect(env["GOTRUE_EXTERNAL_GITHUB_EMAIL_OPTIONAL"]).toBe("true");
      expect(env["GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI"]).toBe(
        "http://127.0.0.1:54321/auth/v1/callback",
      );
      expect(env["GOTRUE_EXTERNAL_GITHUB_URL"]).toBeUndefined();
    });

    test("a provider with a configured base url (keycloak) emits GOTRUE_EXTERNAL_<X>_URL", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        externalProviders: {
          keycloak: {
            enabled: true,
            clientId: "kc-client-id",
            secret: "kc-secret",
            url: "https://keycloak.example.com/realms/myrealm",
            skipNonceCheck: true,
            emailOptional: false,
          },
        },
      });

      expect(env["GOTRUE_EXTERNAL_KEYCLOAK_URL"]).toBe(
        "https://keycloak.example.com/realms/myrealm",
      );
      expect(env["GOTRUE_EXTERNAL_KEYCLOAK_SKIP_NONCE_CHECK"]).toBe("true");
    });

    test("emits full env for a configured-but-disabled provider (Go has no `if config.Enabled` gate)", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        externalProviders: {
          apple: {
            enabled: false,
            clientId: "",
            url: "",
            skipNonceCheck: false,
            emailOptional: false,
          },
        },
      });

      expect(env["GOTRUE_EXTERNAL_APPLE_ENABLED"]).toBe("false");
      expect(env["GOTRUE_EXTERNAL_APPLE_CLIENT_ID"]).toBe("");
      expect(env["GOTRUE_EXTERNAL_APPLE_SECRET"]).toBe("");
    });

    test("omits any env for a provider absent from the (caller-presence-filtered) input map", () => {
      const env = legacyBuildGotrueEnv({ ...baseEnvInput, externalProviders: {} });

      expect(env["GOTRUE_EXTERNAL_GITHUB_ENABLED"]).toBeUndefined();
      expect(env["GOTRUE_EXTERNAL_APPLE_ENABLED"]).toBeUndefined();
      expect(env["GOTRUE_EXTERNAL_AZURE_ENABLED"]).toBeUndefined();
    });
  });

  describe("SMTP / Mailpit fallback", () => {
    test("uses configured SMTP when present, overriding the hardcoded GOTRUE_RATE_LIMIT_EMAIL_SENT default", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        rateLimit: { ...baseEnvInput.rateLimit, email_sent: 99 },
        smtp: {
          host: "smtp.example.com",
          port: 587,
          user: "smtp-user",
          pass: "smtp-pass",
          adminEmail: "admin@example.com",
          senderName: "Example",
        },
      });

      expect(env["GOTRUE_SMTP_HOST"]).toBe("smtp.example.com");
      expect(env["GOTRUE_SMTP_PORT"]).toBe("587");
      expect(env["GOTRUE_SMTP_USER"]).toBe("smtp-user");
      expect(env["GOTRUE_SMTP_PASS"]).toBe("smtp-pass");
      expect(env["GOTRUE_SMTP_ADMIN_EMAIL"]).toBe("admin@example.com");
      expect(env["GOTRUE_SMTP_SENDER_NAME"]).toBe("Example");
      expect(env["GOTRUE_RATE_LIMIT_EMAIL_SENT"]).toBe("99");
    });

    test("falls back to Mailpit when SMTP is unset and local_smtp is enabled", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        mailpit: { containerName: "supabase_inbucket_proj" },
      });

      expect(env["GOTRUE_SMTP_HOST"]).toBe("supabase_inbucket_proj");
      expect(env["GOTRUE_SMTP_PORT"]).toBe("1025");
      expect(env["GOTRUE_SMTP_ADMIN_EMAIL"]).toBe("admin@email.com");
      expect(env["GOTRUE_SMTP_SENDER_NAME"]).toBe("Admin");
      expect(env["GOTRUE_RATE_LIMIT_EMAIL_SENT"]).toBe("360000");
    });

    test("emits neither SMTP nor Mailpit env when both are unset", () => {
      const env = legacyBuildGotrueEnv(baseEnvInput);
      expect(env["GOTRUE_SMTP_HOST"]).toBeUndefined();
      expect(env["GOTRUE_RATE_LIMIT_EMAIL_SENT"]).toBe("360000");
    });
  });

  describe("sessions", () => {
    test("omits GOTRUE_SESSIONS_TIMEBOX/INACTIVITY_TIMEOUT when unset", () => {
      const env = legacyBuildGotrueEnv(baseEnvInput);
      expect(env["GOTRUE_SESSIONS_TIMEBOX"]).toBeUndefined();
      expect(env["GOTRUE_SESSIONS_INACTIVITY_TIMEOUT"]).toBeUndefined();
    });

    test("reformats a configured duration into Go's canonical Duration.String() form", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        sessions: { timebox: "1h", inactivity_timeout: "90s" },
      });
      expect(env["GOTRUE_SESSIONS_TIMEBOX"]).toBe("1h0m0s");
      expect(env["GOTRUE_SESSIONS_INACTIVITY_TIMEOUT"]).toBe("1m30s");
    });

    test("omits a configured but zero-valued duration, matching Go's `> 0` guard", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        sessions: { timebox: "0s" },
      });
      expect(env["GOTRUE_SESSIONS_TIMEBOX"]).toBeUndefined();
    });
  });

  describe("SMS provider switch", () => {
    test("twilio takes priority when multiple providers are enabled", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        sms: {
          ...baseEnvInput.sms,
          twilio: {
            enabled: true,
            account_sid: "AC123",
            message_service_sid: "MG123",
            auth_token: "token123",
          },
          vonage: { enabled: true, from: "vonage-from", api_key: "k", api_secret: "s" },
        },
      });

      expect(env["GOTRUE_SMS_PROVIDER"]).toBe("twilio");
      expect(env["GOTRUE_SMS_TWILIO_ACCOUNT_SID"]).toBe("AC123");
      expect(env["GOTRUE_SMS_TWILIO_AUTH_TOKEN"]).toBe("token123");
      expect(env["GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID"]).toBe("MG123");
      expect(env["GOTRUE_SMS_VONAGE_API_KEY"]).toBeUndefined();
    });

    test("vonage is used when it is the only enabled provider", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        sms: {
          ...baseEnvInput.sms,
          vonage: { enabled: true, from: "vonage-from", api_key: "k", api_secret: "s" },
        },
      });

      expect(env["GOTRUE_SMS_PROVIDER"]).toBe("vonage");
      expect(env["GOTRUE_SMS_VONAGE_FROM"]).toBe("vonage-from");
      expect(env["GOTRUE_SMS_VONAGE_API_KEY"]).toBe("k");
      expect(env["GOTRUE_SMS_VONAGE_API_SECRET"]).toBe("s");
    });

    test("omits GOTRUE_SMS_PROVIDER when no provider is enabled", () => {
      const env = legacyBuildGotrueEnv(baseEnvInput);
      expect(env["GOTRUE_SMS_PROVIDER"]).toBeUndefined();
    });
  });

  describe("CAPTCHA", () => {
    test("emits CAPTCHA env when present", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        captcha: { enabled: true, provider: "hcaptcha", secret: "captcha-secret" },
      });
      expect(env["GOTRUE_SECURITY_CAPTCHA_ENABLED"]).toBe("true");
      expect(env["GOTRUE_SECURITY_CAPTCHA_PROVIDER"]).toBe("hcaptcha");
      expect(env["GOTRUE_SECURITY_CAPTCHA_SECRET"]).toBe("captcha-secret");
    });

    test("omits CAPTCHA env when unset", () => {
      const env = legacyBuildGotrueEnv(baseEnvInput);
      expect(env["GOTRUE_SECURITY_CAPTCHA_ENABLED"]).toBeUndefined();
    });
  });

  describe("hooks", () => {
    test("emits ENABLED/URI/SECRETS for each enabled hook, omits disabled ones", () => {
      const customAccessToken: LegacyGotrueHookInput = {
        enabled: true,
        uri: "pg-functions://postgres/public/custom_access_token_hook",
        secrets: "hook-secret",
      };
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        hooks: { ...baseEnvInput.hooks, customAccessToken },
      });

      expect(env["GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"]).toBe("true");
      expect(env["GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI"]).toBe(
        "pg-functions://postgres/public/custom_access_token_hook",
      );
      expect(env["GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS"]).toBe("hook-secret");
      expect(env["GOTRUE_HOOK_SEND_EMAIL_ENABLED"]).toBeUndefined();
    });
  });

  describe("MFA phone extras", () => {
    test("emits template/otp_length/max_frequency when phone enrollment is enabled", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        mfa: {
          ...baseEnvInput.mfa,
          phone: { ...baseEnvInput.mfa.phone, enroll_enabled: true, max_frequency: "10s" },
        },
      });
      expect(env["GOTRUE_MFA_PHONE_TEMPLATE"]).toBe("Your code is {{ .Code }}");
      expect(env["GOTRUE_MFA_PHONE_OTP_LENGTH"]).toBe("6");
      expect(env["GOTRUE_MFA_PHONE_MAX_FREQUENCY"]).toBe("10s");
    });

    test("omits phone extras when neither enroll nor verify is enabled", () => {
      const env = legacyBuildGotrueEnv(baseEnvInput);
      expect(env["GOTRUE_MFA_PHONE_TEMPLATE"]).toBeUndefined();
      expect(env["GOTRUE_MFA_PHONE_MAX_FREQUENCY"]).toBeUndefined();
    });
  });

  describe("mailer templates and notifications", () => {
    test("emits a template URL and subject, using the content path's extension", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        email: {
          ...baseEnvInput.email,
          template: {
            confirmation: {
              subject: "Confirm your signup",
              content_path: "supabase/templates/confirm.html",
              content_present: false,
            },
          },
        },
      });
      expect(env["GOTRUE_MAILER_TEMPLATES_CONFIRMATION"]).toBe(
        "http://test-kong:8088/email/confirmation.html",
      );
      expect(env["GOTRUE_MAILER_SUBJECTS_CONFIRMATION"]).toBe("Confirm your signup");
    });

    // The email template's subject is optional; the gate is strictly
    // `subject !== undefined`, not on string length — an explicit blank
    // subject is still emitted, distinct from an absent one below.
    test("still emits an explicit empty subject, distinct from an absent one", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        email: {
          ...baseEnvInput.email,
          template: {
            confirmation: {
              subject: "",
              content_path: "supabase/templates/confirm.html",
              content_present: false,
            },
          },
        },
      });
      expect(env["GOTRUE_MAILER_SUBJECTS_CONFIRMATION"]).toBe("");
    });

    test("omits the subject env var entirely when subject is absent (undefined)", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        email: {
          ...baseEnvInput.email,
          template: {
            confirmation: {
              subject: undefined,
              content_path: "supabase/templates/confirm.html",
              content_present: false,
            },
          },
        },
      });
      expect(env).not.toHaveProperty("GOTRUE_MAILER_SUBJECTS_CONFIRMATION");
    });

    test("emits a notification's ENABLED flag and template/subject with the _notification suffix", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        email: {
          ...baseEnvInput.email,
          notification: {
            password_changed: {
              enabled: true,
              subject: "Your password changed",
              content_path: "supabase/templates/password_changed.html",
              content_present: false,
            },
          },
        },
      });
      expect(env["GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED"]).toBe("true");
      expect(env["GOTRUE_MAILER_TEMPLATES_PASSWORD_CHANGED_NOTIFICATION"]).toBe(
        "http://test-kong:8088/email/password_changed_notification.html",
      );
      expect(env["GOTRUE_MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION"]).toBe(
        "Your password changed",
      );
    });

    test("omits a disabled notification's env entirely", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        email: {
          ...baseEnvInput.email,
          notification: {
            password_changed: {
              enabled: false,
              subject: "Your password changed",
              content_path: "supabase/templates/password_changed.html",
              content_present: false,
            },
          },
        },
      });
      expect(env["GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED"]).toBeUndefined();
      expect(env["GOTRUE_MAILER_TEMPLATES_PASSWORD_CHANGED_NOTIFICATION"]).toBeUndefined();
    });
  });

  describe("web3 and OAuth server", () => {
    test("always emits both Web3 flags, regardless of value", () => {
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        web3: { solana: { enabled: true }, ethereum: { enabled: false } },
      });
      expect(env["GOTRUE_EXTERNAL_WEB3_SOLANA_ENABLED"]).toBe("true");
      expect(env["GOTRUE_EXTERNAL_WEB3_ETHEREUM_ENABLED"]).toBe("false");
    });

    test("emits OAuth server env only when enabled", () => {
      const disabled = legacyBuildGotrueEnv(baseEnvInput);
      expect(disabled["GOTRUE_OAUTH_SERVER_ENABLED"]).toBeUndefined();

      const enabled = legacyBuildGotrueEnv({
        ...baseEnvInput,
        oauthServer: {
          enabled: true,
          authorization_url_path: "/oauth/consent",
          allow_dynamic_registration: true,
        },
      });
      expect(enabled["GOTRUE_OAUTH_SERVER_ENABLED"]).toBe("true");
      expect(enabled["GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH"]).toBe("/oauth/consent");
      expect(enabled["GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION"]).toBe("true");
    });
  });

  describe("password requirements", () => {
    test.each([
      ["", ""],
      ["letters_digits", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789"],
      [
        "lower_upper_letters_digits",
        "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
      ],
    ] as const)("%s -> %s", (passwordRequirements, expected) => {
      const env = legacyBuildGotrueEnv({ ...baseEnvInput, passwordRequirements });
      expect(env["GOTRUE_PASSWORD_REQUIRED_CHARACTERS"]).toBe(expected);
    });
  });

  describe("JWT signing keys", () => {
    test("defaults to Go's hardcoded ES256 signing key when unset", () => {
      const env = legacyBuildGotrueEnv(baseEnvInput);
      const keys = JSON.parse(env["GOTRUE_JWT_KEYS"] as string);
      expect(keys).toEqual([
        {
          kty: "EC",
          kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
          use: "sig",
          key_ops: ["sign", "verify"],
          alg: "ES256",
          ext: true,
          crv: "P-256",
          x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
          y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
          d: "dIhR8wywJlqlua4y_yMq2SLhlFXDZJBCvFrY1DCHyVU",
        },
      ]);
      expect(env["GOTRUE_JWT_VALIDMETHODS"]).toBe("HS256,RS256,ES256");
      expect(env["GOTRUE_JWT_VALID_METHODS"]).toBe("HS256,RS256,ES256");
    });

    test("serializes a configured signing key, omitting unset fields", () => {
      const rsaKey: LegacyGotrueSigningKey = { kty: "RSA", alg: "RS256", n: "modulus", e: "AQAB" };
      const env = legacyBuildGotrueEnv({
        ...baseEnvInput,
        signingKeys: [rsaKey],
      });
      expect(JSON.parse(env["GOTRUE_JWT_KEYS"] as string)).toEqual([
        { kty: "RSA", alg: "RS256", n: "modulus", e: "AQAB" },
      ]);
    });
  });
});

describe("legacyBuildGotrueContainerSpec", () => {
  test("assembles the full container spec, deriving dbHost/dbPassword from projectId/dbUrl", () => {
    const spec = legacyBuildGotrueContainerSpec({
      image: "supabase/gotrue:v2.180.0",
      projectId: "proj",
      networkId: "supabase_network_proj",
      dbUrl: "postgresql://postgres:secret@127.0.0.1:54322/postgres",
      env: baseEnvInput,
    });

    expect(spec.image).toBe("supabase/gotrue:v2.180.0");
    expect(spec.containerName).toBe("supabase_auth_proj");
    expect(spec.binds).toEqual([]);
    expect(spec.ports).toBeUndefined();
    expect(spec.exposedPorts).toEqual([{ containerPort: "9999" }]);
    expect(spec.healthcheck).toEqual({
      test: [
        "CMD",
        "wget",
        "--no-verbose",
        "--tries=1",
        "--spider",
        "http://127.0.0.1:9999/health",
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    });
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.networkId).toBe("supabase_network_proj");
    expect(spec.networkAliases).toEqual(["auth"]);
    expect(spec.labels).toEqual({});

    // dbHost/dbPassword flow from projectId/dbUrl into the env's connection string.
    expect(spec.env["GOTRUE_DB_DATABASE_URL"]).toBe(
      "postgresql://supabase_auth_admin:secret@supabase_db_proj:5432/postgres",
    );
  });
});
