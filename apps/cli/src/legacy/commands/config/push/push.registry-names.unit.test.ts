/**
 * Unit tests for push.registry-names.ts — pins the exact contents of every
 * registry-derived name list, since the registry itself gives no ordering
 * guarantee.
 */

import { describe, expect, it } from "vitest";

import {
  LEGACY_EMAIL_NOTIFICATION_NAMES,
  LEGACY_EMAIL_TEMPLATE_NAMES,
  LEGACY_EXTERNAL_PROVIDER_IDS,
  LEGACY_PROVIDERS_WITH_EMAIL_OPTIONAL,
  LEGACY_PROVIDERS_WITH_SKIP_NONCE_CHECK,
  LEGACY_PROVIDERS_WITH_URL,
  LEGACY_SMS_PROVIDER_NAMES,
} from "./push.registry-names.ts";

describe("LEGACY_EXTERNAL_PROVIDER_IDS", () => {
  it("names exactly the 19 external provider ids", () => {
    expect(LEGACY_EXTERNAL_PROVIDER_IDS).toEqual([
      "apple",
      "azure",
      "bitbucket",
      "discord",
      "facebook",
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

describe("LEGACY_PROVIDERS_WITH_URL", () => {
  it("names exactly azure, gitlab, keycloak, workos", () => {
    expect(LEGACY_PROVIDERS_WITH_URL).toEqual(["azure", "gitlab", "keycloak", "workos"]);
  });
});

describe("LEGACY_PROVIDERS_WITH_SKIP_NONCE_CHECK", () => {
  it("names exactly google", () => {
    expect(LEGACY_PROVIDERS_WITH_SKIP_NONCE_CHECK).toEqual(["google"]);
  });
});

describe("LEGACY_PROVIDERS_WITH_EMAIL_OPTIONAL", () => {
  it("names every external provider except workos", () => {
    expect(LEGACY_PROVIDERS_WITH_EMAIL_OPTIONAL).toEqual(
      LEGACY_EXTERNAL_PROVIDER_IDS.filter((id) => id !== "workos"),
    );
    expect(LEGACY_PROVIDERS_WITH_EMAIL_OPTIONAL).not.toContain("workos");
  });
});

describe("LEGACY_SMS_PROVIDER_NAMES", () => {
  it("names exactly the 5 SMS providers", () => {
    expect(LEGACY_SMS_PROVIDER_NAMES).toEqual([
      "twilio",
      "twilio_verify",
      "messagebird",
      "textlocal",
      "vonage",
    ]);
  });
});

describe("LEGACY_EMAIL_TEMPLATE_NAMES", () => {
  it("names exactly the 6 email templates", () => {
    expect(LEGACY_EMAIL_TEMPLATE_NAMES).toEqual([
      "invite",
      "confirmation",
      "recovery",
      "magic_link",
      "email_change",
      "reauthentication",
    ]);
  });
});

describe("LEGACY_EMAIL_NOTIFICATION_NAMES", () => {
  it("names exactly the 7 email notifications", () => {
    expect(LEGACY_EMAIL_NOTIFICATION_NAMES).toEqual([
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
