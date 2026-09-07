/**
 * Unit tests for push.secrets.ts.
 */

import type { CliConfig, ProjectConfig } from "@supabase/config";
import { getDefaultCliConfig } from "@supabase/config";
import { projectConfigMappingRows } from "@supabase/config/internal";
import { describe, expect, it } from "vitest";

import { legacySecretDigestHex } from "./push.secret.ts";
import { legacyResolveAuthSecrets } from "./push.secrets.ts";

const PROJECT_REF = "abcdefghijklmnopqrst";

function hex(value: string): string {
  const digest = legacySecretDigestHex(PROJECT_REF, value, []);
  if (digest === undefined) {
    throw new Error("test fixture value must hash to a digest");
  }
  return digest;
}

/** A fully-enabled fixture: every one of the 5 secret-bearing families turned on with a distinct value. */
function buildFullyEnabledConfig(): CliConfig {
  const base = getDefaultCliConfig();
  return {
    ...base,
    auth: {
      ...base.auth,
      captcha: { enabled: true, provider: "hcaptcha", secret: "captcha-secret" },
      email: {
        ...base.auth.email,
        smtp: {
          enabled: true,
          host: "smtp.example.com",
          port: 587,
          user: "smtp-user",
          pass: "smtp-secret",
          admin_email: "admin@example.com",
          sender_name: "Sender",
        },
      },
      sms: {
        ...base.auth.sms,
        twilio: {
          enabled: true,
          account_sid: "twilio-sid",
          message_service_sid: "twilio-svc",
          auth_token: "twilio-secret",
        },
        twilio_verify: {
          enabled: true,
          account_sid: "twilio-verify-sid",
          message_service_sid: "twilio-verify-svc",
          auth_token: "twilio-verify-secret",
        },
        messagebird: { enabled: true, originator: "orig", access_key: "messagebird-secret" },
        textlocal: { enabled: true, sender: "sender", api_key: "textlocal-secret" },
        vonage: {
          enabled: true,
          from: "from",
          api_key: "vonage-key",
          api_secret: "vonage-secret",
        },
      },
      hook: {
        mfa_verification_attempt: { enabled: true, uri: "https://x", secrets: "hook-secret-1" },
        password_verification_attempt: {
          enabled: true,
          uri: "https://x",
          secrets: "hook-secret-2",
        },
        custom_access_token: { enabled: true, uri: "https://x", secrets: "hook-secret-3" },
        send_sms: { enabled: true, uri: "https://x", secrets: "hook-secret-4" },
        send_email: { enabled: true, uri: "https://x", secrets: "hook-secret-5" },
        before_user_created: { enabled: true, uri: "https://x", secrets: "hook-secret-6" },
      },
      external: {
        apple: { ...base.auth.external.apple, enabled: true, secret: "apple-secret" },
        azure: { ...base.auth.external.azure, enabled: true, secret: "azure-secret" },
        bitbucket: { ...base.auth.external.bitbucket, enabled: true, secret: "bitbucket-secret" },
        discord: { ...base.auth.external.discord, enabled: true, secret: "discord-secret" },
        facebook: { ...base.auth.external.facebook, enabled: true, secret: "facebook-secret" },
        figma: { ...base.auth.external.figma, enabled: true, secret: "figma-secret" },
        github: { ...base.auth.external.github, enabled: true, secret: "github-secret" },
        gitlab: { ...base.auth.external.gitlab, enabled: true, secret: "gitlab-secret" },
        google: { ...base.auth.external.google, enabled: true, secret: "google-secret" },
        kakao: { ...base.auth.external.kakao, enabled: true, secret: "kakao-secret" },
        keycloak: { ...base.auth.external.keycloak, enabled: true, secret: "keycloak-secret" },
        linkedin_oidc: {
          ...base.auth.external.linkedin_oidc,
          enabled: true,
          secret: "linkedin-secret",
        },
        notion: { ...base.auth.external.notion, enabled: true, secret: "notion-secret" },
        slack_oidc: { ...base.auth.external.slack_oidc, enabled: true, secret: "slack-secret" },
        spotify: { ...base.auth.external.spotify, enabled: true, secret: "spotify-secret" },
        twitch: { ...base.auth.external.twitch, enabled: true, secret: "twitch-secret" },
        twitter: { ...base.auth.external.twitter, enabled: true, secret: "twitter-secret" },
        x: { ...base.auth.external.x, enabled: true, secret: "x-secret" },
        workos: { ...base.auth.external.workos, enabled: true, secret: "workos-secret" },
        zoom: { ...base.auth.external.zoom, enabled: true, secret: "zoom-secret" },
      },
    },
  };
}

/** Every secret path the fully-enabled fixture above sets, with its plaintext value. */
const FULLY_ENABLED_SECRET_VALUES: ReadonlyArray<{
  readonly path: ReadonlyArray<string>;
  readonly value: string;
}> = [
  { path: ["auth", "captcha", "secret"], value: "captcha-secret" },
  { path: ["auth", "email", "smtp", "pass"], value: "smtp-secret" },
  { path: ["auth", "sms", "twilio", "auth_token"], value: "twilio-secret" },
  { path: ["auth", "sms", "twilio_verify", "auth_token"], value: "twilio-verify-secret" },
  { path: ["auth", "sms", "messagebird", "access_key"], value: "messagebird-secret" },
  { path: ["auth", "sms", "textlocal", "api_key"], value: "textlocal-secret" },
  { path: ["auth", "sms", "vonage", "api_secret"], value: "vonage-secret" },
  { path: ["auth", "hook", "mfa_verification_attempt", "secrets"], value: "hook-secret-1" },
  { path: ["auth", "hook", "password_verification_attempt", "secrets"], value: "hook-secret-2" },
  { path: ["auth", "hook", "custom_access_token", "secrets"], value: "hook-secret-3" },
  { path: ["auth", "hook", "send_sms", "secrets"], value: "hook-secret-4" },
  { path: ["auth", "hook", "send_email", "secrets"], value: "hook-secret-5" },
  { path: ["auth", "hook", "before_user_created", "secrets"], value: "hook-secret-6" },
  { path: ["auth", "external", "apple", "secret"], value: "apple-secret" },
  { path: ["auth", "external", "azure", "secret"], value: "azure-secret" },
  { path: ["auth", "external", "bitbucket", "secret"], value: "bitbucket-secret" },
  { path: ["auth", "external", "discord", "secret"], value: "discord-secret" },
  { path: ["auth", "external", "facebook", "secret"], value: "facebook-secret" },
  { path: ["auth", "external", "figma", "secret"], value: "figma-secret" },
  { path: ["auth", "external", "github", "secret"], value: "github-secret" },
  { path: ["auth", "external", "gitlab", "secret"], value: "gitlab-secret" },
  { path: ["auth", "external", "google", "secret"], value: "google-secret" },
  { path: ["auth", "external", "kakao", "secret"], value: "kakao-secret" },
  { path: ["auth", "external", "keycloak", "secret"], value: "keycloak-secret" },
  { path: ["auth", "external", "linkedin_oidc", "secret"], value: "linkedin-secret" },
  { path: ["auth", "external", "notion", "secret"], value: "notion-secret" },
  { path: ["auth", "external", "slack_oidc", "secret"], value: "slack-secret" },
  { path: ["auth", "external", "spotify", "secret"], value: "spotify-secret" },
  { path: ["auth", "external", "twitch", "secret"], value: "twitch-secret" },
  { path: ["auth", "external", "twitter", "secret"], value: "twitter-secret" },
  { path: ["auth", "external", "x", "secret"], value: "x-secret" },
  { path: ["auth", "external", "workos", "secret"], value: "workos-secret" },
  { path: ["auth", "external", "zoom", "secret"], value: "zoom-secret" },
];

function fullyEnabledLocal(): ProjectConfig {
  const config = buildFullyEnabledConfig();
  return { auth: config.auth };
}

describe("legacyResolveAuthSecrets", () => {
  it("resolves the registry's own apiPath[1] as apiKey for every secret row", () => {
    const config = buildFullyEnabledConfig();
    const local = fullyEnabledLocal();
    const maskedPaths = FULLY_ENABLED_SECRET_VALUES.map((entry) => entry.path);
    const decisions = legacyResolveAuthSecrets({
      maskedPaths,
      config,
      local,
      remoteAuthAttributes: {},
      projectRef: PROJECT_REF,
      dotenvPrivateKeys: [],
    });

    expect(decisions).toHaveLength(FULLY_ENABLED_SECRET_VALUES.length);
    for (const decision of decisions) {
      const row = projectConfigMappingRows.find(
        (candidate) =>
          candidate.isSecret === true &&
          candidate.configPath.length === decision.path.length &&
          candidate.configPath.every((segment, index) => segment === decision.path[index]),
      );
      expect(row).toBeDefined();
      expect(decision.apiKey).toBe(row?.apiPath[1]);
      // Nothing declared on `remoteAuthAttributes`, so every one of these sends.
      expect(decision.status).toBe("send");
    }
  });

  it("marks a secret unchanged when its digest matches the remote attribute", () => {
    const config = buildFullyEnabledConfig();
    const local = fullyEnabledLocal();
    const decisions = legacyResolveAuthSecrets({
      maskedPaths: [["auth", "captcha", "secret"]],
      config,
      local,
      remoteAuthAttributes: { security_captcha_secret: hex("captcha-secret") },
      projectRef: PROJECT_REF,
      dotenvPrivateKeys: [],
    });
    expect(decisions).toEqual([
      {
        path: ["auth", "captcha", "secret"],
        apiKey: "security_captcha_secret",
        status: "unchanged",
        remoteState: "present",
      },
    ]);
  });

  it.each<[string, unknown, "absent" | "present"]>([
    ["a differing digest", hex("some-other-value"), "present"],
    ["null", null, "absent"],
    ["an empty string", "", "absent"],
    ["absent", undefined, "absent"],
  ])("sends the plaintext when the remote attribute is %s", (_label, remoteValue, remoteState) => {
    const config = buildFullyEnabledConfig();
    const local = fullyEnabledLocal();
    const remoteAuthAttributes: Record<string, unknown> =
      remoteValue === undefined ? {} : { security_captcha_secret: remoteValue };
    const decisions = legacyResolveAuthSecrets({
      maskedPaths: [["auth", "captcha", "secret"]],
      config,
      local,
      remoteAuthAttributes,
      projectRef: PROJECT_REF,
      dotenvPrivateKeys: [],
    });
    expect(decisions).toEqual([
      {
        path: ["auth", "captcha", "secret"],
        apiKey: "security_captcha_secret",
        status: "send",
        remoteState,
        plaintext: "captcha-secret",
      },
    ]);
  });

  it("marks an empty local value not_set, never sent", () => {
    const base = getDefaultCliConfig();
    const config: CliConfig = {
      ...base,
      auth: { ...base.auth, captcha: { enabled: true, provider: "hcaptcha", secret: "" } },
    };
    const local: ProjectConfig = { auth: { captcha: { enabled: true } } };
    const decisions = legacyResolveAuthSecrets({
      maskedPaths: [["auth", "captcha", "secret"]],
      config,
      local,
      remoteAuthAttributes: {},
      projectRef: PROJECT_REF,
      dotenvPrivateKeys: [],
    });
    expect(decisions).toEqual([
      {
        path: ["auth", "captcha", "secret"],
        apiKey: "security_captcha_secret",
        status: "not_set",
        remoteState: "absent",
      },
    ]);
  });

  it("marks an unresolved env(VAR) reference not_set, never sent", () => {
    const base = getDefaultCliConfig();
    const config: CliConfig = {
      ...base,
      auth: {
        ...base.auth,
        captcha: { enabled: true, provider: "hcaptcha", secret: "env(MY_CAPTCHA_SECRET)" },
      },
    };
    const local: ProjectConfig = { auth: { captcha: { enabled: true } } };
    const decisions = legacyResolveAuthSecrets({
      maskedPaths: [["auth", "captcha", "secret"]],
      config,
      local,
      remoteAuthAttributes: {},
      projectRef: PROJECT_REF,
      dotenvPrivateKeys: [],
    });
    expect(decisions).toEqual([
      {
        path: ["auth", "captcha", "secret"],
        apiKey: "security_captcha_secret",
        status: "not_set",
        remoteState: "absent",
      },
    ]);
  });

  describe("gating — disabled or absent parent, across all five families", () => {
    it.each<[string, ReadonlyArray<string>, ProjectConfig]>([
      [
        "captcha (disabled)",
        ["auth", "captcha", "secret"],
        { auth: { captcha: { enabled: false } } },
      ],
      ["captcha (absent)", ["auth", "captcha", "secret"], { auth: {} }],
      [
        "smtp (disabled)",
        ["auth", "email", "smtp", "pass"],
        { auth: { email: { smtp: { enabled: false } } } },
      ],
      ["smtp (absent)", ["auth", "email", "smtp", "pass"], { auth: { email: {} } }],
      [
        "sms provider (disabled)",
        ["auth", "sms", "twilio", "auth_token"],
        { auth: { sms: { twilio: { enabled: false } } } },
      ],
      ["sms provider (absent)", ["auth", "sms", "twilio", "auth_token"], { auth: { sms: {} } }],
      [
        "hook (disabled)",
        ["auth", "hook", "before_user_created", "secrets"],
        { auth: { hook: { before_user_created: { enabled: false } } } },
      ],
      ["hook (absent)", ["auth", "hook", "before_user_created", "secrets"], { auth: { hook: {} } }],
      [
        "external provider (disabled)",
        ["auth", "external", "google", "secret"],
        { auth: { external: { google: { enabled: false } } } },
      ],
      [
        "external provider (absent)",
        ["auth", "external", "google", "secret"],
        { auth: { external: {} } },
      ],
    ])("%s → gated, never sent", (_label, path, local) => {
      const config = buildFullyEnabledConfig();
      const decisions = legacyResolveAuthSecrets({
        maskedPaths: [path],
        config,
        local,
        remoteAuthAttributes: {},
        projectRef: PROJECT_REF,
        dotenvPrivateKeys: [],
      });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.status).toBe("gated");
      expect(decisions[0]?.plaintext).toBeUndefined();
    });

    it("gates when the container is present but its `enabled` field is not a boolean (never coerced to eligible)", () => {
      const config = buildFullyEnabledConfig();
      // No `enabled` key at all on the captcha container — an undetermined
      // state, not an eligible one.
      const local: ProjectConfig = { auth: { captcha: {} } };
      const decisions = legacyResolveAuthSecrets({
        maskedPaths: [["auth", "captcha", "secret"]],
        config,
        local,
        remoteAuthAttributes: {},
        projectRef: PROJECT_REF,
        dotenvPrivateKeys: [],
      });
      expect(decisions).toEqual([
        {
          path: ["auth", "captcha", "secret"],
          apiKey: "security_captcha_secret",
          status: "gated",
          remoteState: "absent",
        },
      ]);
    });
  });

  describe("dotenvx encrypted: values", () => {
    const PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
    const ENCRYPTED_VALUE =
      "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

    it("decrypts before hashing and before sending — never the ciphertext", () => {
      const base = getDefaultCliConfig();
      const config: CliConfig = {
        ...base,
        auth: {
          ...base.auth,
          captcha: { enabled: true, provider: "hcaptcha", secret: ENCRYPTED_VALUE },
        },
      };
      const local: ProjectConfig = { auth: { captcha: { enabled: true } } };
      const decisions = legacyResolveAuthSecrets({
        maskedPaths: [["auth", "captcha", "secret"]],
        config,
        local,
        remoteAuthAttributes: {},
        projectRef: PROJECT_REF,
        dotenvPrivateKeys: [PRIVATE_KEY],
      });
      expect(decisions).toEqual([
        {
          path: ["auth", "captcha", "secret"],
          apiKey: "security_captcha_secret",
          status: "send",
          remoteState: "absent",
          plaintext: "value",
        },
      ]);
    });

    it("compares the decrypted digest against the remote attribute", () => {
      const base = getDefaultCliConfig();
      const config: CliConfig = {
        ...base,
        auth: {
          ...base.auth,
          captcha: { enabled: true, provider: "hcaptcha", secret: ENCRYPTED_VALUE },
        },
      };
      const local: ProjectConfig = { auth: { captcha: { enabled: true } } };
      const decisions = legacyResolveAuthSecrets({
        maskedPaths: [["auth", "captcha", "secret"]],
        config,
        local,
        remoteAuthAttributes: { security_captcha_secret: hex("value") },
        projectRef: PROJECT_REF,
        dotenvPrivateKeys: [PRIVATE_KEY],
      });
      expect(decisions).toEqual([
        {
          path: ["auth", "captcha", "secret"],
          apiKey: "security_captcha_secret",
          status: "unchanged",
          remoteState: "present",
        },
      ]);
    });
  });

  it("ignores a masked path with no matching secret row", () => {
    const decisions = legacyResolveAuthSecrets({
      maskedPaths: [["auth", "not_a_real_secret"]],
      config: getDefaultCliConfig(),
      local: {},
      remoteAuthAttributes: {},
      projectRef: PROJECT_REF,
      dotenvPrivateKeys: [],
    });
    expect(decisions).toEqual([]);
  });
});
