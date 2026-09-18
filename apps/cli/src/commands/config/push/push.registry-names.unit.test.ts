/**
 * Unit tests for push.registry-names.ts — pins the exact contents of every
 * registry-derived name list, since the registry itself gives no ordering
 * guarantee.
 */

import { describe, expect, it } from "vitest";

import {
  EMAIL_NOTIFICATION_NAMES,
  EMAIL_TEMPLATE_NAMES,
  EXTERNAL_PROVIDER_IDS,
  PROVIDERS_WITH_EMAIL_OPTIONAL,
  PROVIDERS_WITH_SKIP_NONCE_CHECK,
  PROVIDERS_WITH_URL,
  SMS_PROVIDER_NAMES,
} from "./push.registry-names.ts";

describe("EXTERNAL_PROVIDER_IDS", () => {
  it("names exactly the 20 external provider ids", () => {
    expect(EXTERNAL_PROVIDER_IDS).toEqual([
      "apple",
      "azure",
      "bitbucket",
      "discord",
      "facebook",
      "figma",
      "github",
      "gitlab",
      "google",
      "kakao",
      "keycloak",
      "linkedin_oidc",
      "notion",
      "slack_oidc",
      "spotify",
      "twitch",
      "twitter",
      "x",
      "workos",
      "zoom",
    ]);
  });
});

describe("PROVIDERS_WITH_URL", () => {
  it("names exactly azure, gitlab, keycloak, workos", () => {
    expect(PROVIDERS_WITH_URL).toEqual(["azure", "gitlab", "keycloak", "workos"]);
  });
});

describe("PROVIDERS_WITH_SKIP_NONCE_CHECK", () => {
  it("names exactly google", () => {
    expect(PROVIDERS_WITH_SKIP_NONCE_CHECK).toEqual(["google"]);
  });
});

describe("PROVIDERS_WITH_EMAIL_OPTIONAL", () => {
  it("names every external provider except workos", () => {
    expect(PROVIDERS_WITH_EMAIL_OPTIONAL).toEqual(
      EXTERNAL_PROVIDER_IDS.filter((id) => id !== "workos"),
    );
    expect(PROVIDERS_WITH_EMAIL_OPTIONAL).not.toContain("workos");
  });
});

describe("SMS_PROVIDER_NAMES", () => {
  it("names exactly the 5 SMS providers", () => {
    expect(SMS_PROVIDER_NAMES).toEqual([
      "twilio",
      "twilio_verify",
      "messagebird",
      "textlocal",
      "vonage",
    ]);
  });
});

describe("EMAIL_TEMPLATE_NAMES", () => {
  it("names exactly the 6 email templates", () => {
    expect(EMAIL_TEMPLATE_NAMES).toEqual([
      "invite",
      "confirmation",
      "recovery",
      "magic_link",
      "email_change",
      "reauthentication",
    ]);
  });
});

describe("EMAIL_NOTIFICATION_NAMES", () => {
  it("names exactly the 7 email notifications", () => {
    expect(EMAIL_NOTIFICATION_NAMES).toEqual([
      "password_changed",
      "email_changed",
      "phone_changed",
      "identity_linked",
      "identity_unlinked",
      "mfa_factor_enrolled",
      "mfa_factor_unenrolled",
    ]);
  });
});
