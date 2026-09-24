import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { Creation, makeSpec } from "./Auth.ts";
import { Settings, settingsEnvironment } from "./AuthSettings.ts";

describe("Auth settings environment", () => {
  it("derives public Auth defaults from configured external URLs", () => {
    const creation = Schema.decodeSync(Creation)({
      service: "auth",
      config: {
        databaseUrl: "postgresql://localhost/postgres",
        apiExternalUrl: "https://api.example",
        authExternalUrl: "https://login.example/auth/v1/",
      },
    });
    const env = Effect.runSync(makeSpec().env(creation, new Map(), false));

    expect(env.API_EXTERNAL_URL).toBe("https://login.example/auth/v1/");
    expect(env.GOTRUE_JWT_ISSUER).toBe("https://login.example/auth/v1/");
    expect(env.GOTRUE_MAILER_URLPATHS_INVITE).toBe("https://login.example/auth/v1/verify");
  });

  it("uses the default email rate limit without SMTP and configured limit with custom SMTP", () => {
    const run = (config: Record<string, unknown>) => {
      const creation = Schema.decodeSync(Creation)({
        service: "auth",
        config: { databaseUrl: "postgresql://localhost/postgres", ...config },
      });
      return Effect.runSync(makeSpec().env(creation, new Map(), false));
    };

    const defaults = run({ settings: { rateLimit: { email_sent: 17 } } });
    const localMail = run({
      smtpUrl: "smtp://mailpit:1025",
      settings: { rateLimit: { email_sent: 17 } },
    });
    const customMail = run({
      smtp: {
        host: "smtp.example.test",
        port: 587,
        user: "user",
        pass: "pass",
        adminEmail: "admin@example.test",
      },
      settings: { rateLimit: { email_sent: 17 } },
    });

    expect(defaults.GOTRUE_RATE_LIMIT_EMAIL_SENT).toBe("360000");
    expect(localMail.GOTRUE_RATE_LIMIT_EMAIL_SENT).toBe("360000");
    expect(customMail.GOTRUE_RATE_LIMIT_EMAIL_SENT).toBe("17");
  });

  it("uses auth URLs for verify and provider callbacks and forwards passkey settings", () => {
    const settings = Schema.decodeSync(Settings)({
      jwtIssuer: "https://issuer.example",
      passkeyEnabled: true,
      webauthn: {
        rpId: "example.test",
        rpDisplayName: "Example",
        rpOrigins: ["https://example.test", "https://app.example.test"],
      },
      external: {
        custom: {
          enabled: false,
          client_id: "client",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
      },
      email: {
        enable_signup: true,
        double_confirm_changes: true,
        enable_confirmations: true,
        secure_password_change: false,
        max_frequency: "1m",
        otp_length: 6,
        otp_expiry: 3600,
        template: {},
        notification: {
          password_changed: { enabled: false, subject: "disabled" },
          email_changed: { enabled: true, subject: "changed" },
        },
      },
    });

    const env = settingsEnvironment(settings, "https://issuer.example");

    expect(env["GOTRUE_EXTERNAL_CUSTOM_REDIRECT_URI"]).toBe("https://issuer.example/callback");
    expect(env["GOTRUE_EXTERNAL_CUSTOM_SECRET"]).toBe("");
    expect(env["GOTRUE_PASSKEY_ENABLED"]).toBe("true");
    expect(env["GOTRUE_WEBAUTHN_RP_ORIGINS"]).toBe("https://example.test,https://app.example.test");
    expect(env["GOTRUE_MAILER_NOTIFICATIONS_EMAIL_CHANGED_ENABLED"]).toBe("true");
    expect(env["GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGED_NOTIFICATION"]).toBe("changed");
    expect(env["GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED"]).toBeUndefined();
    expect(env["GOTRUE_MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION"]).toBeUndefined();
  });
});
