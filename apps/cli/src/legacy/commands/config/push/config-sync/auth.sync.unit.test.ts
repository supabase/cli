/**
 * Unit tests for auth.sync.ts — golden parity with Go `pkg/config/auth_test.go`.
 *
 * Each test builds `AuthSubset` values directly (secrets already pre-hashed,
 * durations already in Go `.String()` form) and calls `diffAuth`, mirroring
 * Go's `assertSnapshotEqual(t, diff)` approach. Expected diffs are the literal
 * bytes of `apps/cli-go/pkg/config/testdata/TestXxxDiff/*.diff`.
 *
 * Go's `newWithDefaults()` sets:
 *   EnableSignup = true
 *   AdditionalRedirectUrls = []string{}
 *   Email.EnableConfirmations = true
 *   Sms.TestOTP = map[string]string{}
 */

import { V1UpdateAuthServiceConfigInput } from "@supabase/api/effect";
import { Exit } from "effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  applyRemoteAuthConfig,
  authToUpdateBody,
  diffAuth,
  type AuthSubset,
  type RemoteAuthConfig,
} from "./auth.sync.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const lines = (...l: ReadonlyArray<string>) => l.join("\n") + "\n";

/** Mirror of Go `newWithDefaults()` projected to AuthSubset. */
function bareAuth(overrides: Partial<AuthSubset> = {}): AuthSubset {
  return {
    enabled: false,
    site_url: "",
    external_url: "",
    additional_redirect_urls: [],
    jwt_expiry: 0,
    jwt_issuer: "",
    enable_refresh_token_rotation: false,
    refresh_token_reuse_interval: 0,
    enable_manual_linking: false,
    enable_signup: true,
    enable_anonymous_sign_ins: false,
    minimum_password_length: 0,
    password_requirements: "",
    signing_keys_path: "",
    passkey: undefined,
    webauthn: undefined,
    rate_limit: {
      anonymous_users: 0,
      token_refresh: 0,
      sign_in_sign_ups: 0,
      token_verifications: 0,
      email_sent: 0,
      sms_sent: 0,
      web3: 0,
    },
    captcha: undefined,
    hook: {
      mfa_verification_attempt: undefined,
      password_verification_attempt: undefined,
      custom_access_token: undefined,
      send_sms: undefined,
      send_email: undefined,
      before_user_created: undefined,
    },
    mfa: {
      max_enrolled_factors: 0,
      totp: { enroll_enabled: false, verify_enabled: false },
      phone: {
        enroll_enabled: false,
        verify_enabled: false,
        otp_length: 0,
        template: "",
        max_frequency: "0s",
      },
      web_authn: { enroll_enabled: false, verify_enabled: false },
    },
    sessions: { timebox: "0s", inactivity_timeout: "0s" },
    email: {
      enable_signup: false,
      double_confirm_changes: false,
      enable_confirmations: true,
      secure_password_change: false,
      max_frequency: "0s",
      otp_length: 0,
      otp_expiry: 0,
      smtp: undefined,
      template: undefined,
      notification: undefined,
    },
    sms: {
      enable_signup: false,
      enable_confirmations: false,
      template: "",
      max_frequency: "0s",
      twilio: { enabled: false, account_sid: "", message_service_sid: "", auth_token: "" },
      twilio_verify: { enabled: false, account_sid: "", message_service_sid: "", auth_token: "" },
      messagebird: { enabled: false, originator: "", access_key: "" },
      textlocal: { enabled: false, sender: "", api_key: "" },
      vonage: { enabled: false, from: "", api_key: "", api_secret: "" },
      test_otp: {},
    },
    external: {},
    web3: {
      solana: { enabled: false },
      ethereum: { enabled: false },
    },
    oauth_server: { enabled: false, allow_dynamic_registration: false, authorization_url_path: "" },
    publishable_key: "",
    secret_key: "",
    jwt_secret: "",
    anon_key: "",
    service_role_key: "",
    third_party: {
      firebase: { enabled: false, project_id: "" },
      auth0: { enabled: false, tenant: "", tenant_region: "" },
      aws_cognito: { enabled: false, user_pool_id: "", user_pool_region: "" },
      clerk: { enabled: false, domain: "" },
      workos: { enabled: false, issuer_url: "" },
    },
    rawSecrets: {
      captcha: "",
      hooks: {},
      smtp_pass: "",
      sms: { twilio: "", twilio_verify: "", messagebird: "", textlocal: "", vonage: "" },
      providers: {},
    },
    ...overrides,
  };
}

/** Apply remote to a local subset and return the resulting "remote copy". */
function withRemote(local: AuthSubset, remote: RemoteAuthConfig): AuthSubset {
  return applyRemoteAuthConfig(local, remote);
}

// ---------------------------------------------------------------------------
// TestAuthDiff
// ---------------------------------------------------------------------------

describe("TestAuthDiff", () => {
  it("local and remote enabled — no diff", () => {
    const local = bareAuth({
      site_url: "http://127.0.0.1:3000",
      additional_redirect_urls: ["https://127.0.0.1:3000"],
      jwt_expiry: 3600,
      enable_refresh_token_rotation: true,
      refresh_token_reuse_interval: 10,
      enable_manual_linking: true,
      enable_signup: true,
      enable_anonymous_sign_ins: true,
      minimum_password_length: 6,
      password_requirements: "letters_digits",
    });
    const remote = withRemote(local, {
      site_url: "http://127.0.0.1:3000",
      uri_allow_list: "https://127.0.0.1:3000",
      jwt_exp: 3600,
      refresh_token_rotation_enabled: true,
      security_refresh_token_reuse_interval: 10,
      security_manual_linking_enabled: true,
      disable_signup: false,
      external_anonymous_users_enabled: true,
      password_min_length: 6,
      password_required_characters:
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
    });
    expect(diffAuth(remote, local)).toBe("");
  });

  it("local enabled and disabled — matches golden diff", () => {
    const local = bareAuth({
      site_url: "http://127.0.0.1:3000",
      additional_redirect_urls: ["https://127.0.0.1:3000"],
      jwt_expiry: 3600,
      enable_refresh_token_rotation: false,
      refresh_token_reuse_interval: 10,
      enable_manual_linking: false,
      enable_signup: false,
      enable_anonymous_sign_ins: false,
      minimum_password_length: 6,
      password_requirements: "lower_upper_letters_digits_symbols",
    });
    const remote = withRemote(local, {
      site_url: "",
      uri_allow_list: "https://127.0.0.1:3000,https://ref.supabase.co",
      jwt_exp: 0,
      refresh_token_rotation_enabled: true,
      security_refresh_token_reuse_interval: 0,
      security_manual_linking_enabled: true,
      disable_signup: false,
      external_anonymous_users_enabled: true,
      password_min_length: 8,
      password_required_characters:
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
    });
    expect(diffAuth(remote, local)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -1,16 +1,16 @@",
        " enabled = false",
        '-site_url = ""',
        '+site_url = "http://127.0.0.1:3000"',
        ' external_url = ""',
        '-additional_redirect_urls = ["https://127.0.0.1:3000", "https://ref.supabase.co"]',
        "-jwt_expiry = 0",
        '+additional_redirect_urls = ["https://127.0.0.1:3000"]',
        "+jwt_expiry = 3600",
        ' jwt_issuer = ""',
        "-enable_refresh_token_rotation = true",
        "-refresh_token_reuse_interval = 0",
        "-enable_manual_linking = true",
        "-enable_signup = true",
        "-enable_anonymous_sign_ins = true",
        "-minimum_password_length = 8",
        '-password_requirements = "letters_digits"',
        "+enable_refresh_token_rotation = false",
        "+refresh_token_reuse_interval = 10",
        "+enable_manual_linking = false",
        "+enable_signup = false",
        "+enable_anonymous_sign_ins = false",
        "+minimum_password_length = 6",
        '+password_requirements = "lower_upper_letters_digits_symbols"',
        ' signing_keys_path = ""',
        ' publishable_key = ""',
        ' secret_key = ""',
      ),
    );
  });

  it("local and remote disabled — no diff", () => {
    const local = bareAuth({ enable_signup: false });
    const remote = withRemote(local, {
      site_url: "",
      uri_allow_list: "",
      jwt_exp: 0,
      refresh_token_rotation_enabled: false,
      security_refresh_token_reuse_interval: 0,
      security_manual_linking_enabled: false,
      disable_signup: true,
      external_anonymous_users_enabled: false,
      password_min_length: 0,
      password_required_characters: "",
    });
    expect(diffAuth(remote, local)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TestCaptchaDiff
// ---------------------------------------------------------------------------

describe("TestCaptchaDiff", () => {
  it("local and remote enabled — no diff", () => {
    const local = bareAuth({
      captcha: {
        enabled: true,
        provider: "hcaptcha",
        secret: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      },
    });
    const remote = withRemote(local, {
      security_captcha_enabled: true,
      security_captcha_provider: "hcaptcha",
      security_captcha_secret: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
    });
    expect(diffAuth(remote, local)).toBe("");
  });

  it("local disabled remote enabled — matches golden diff", () => {
    const local = bareAuth({
      captcha: {
        enabled: false,
        provider: "turnstile",
        secret: "hash:ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e",
      },
    });
    const remote = withRemote(local, {
      security_captcha_enabled: true,
      security_captcha_provider: "hcaptcha",
      security_captcha_secret: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
    });
    // local disabled: fromAuthConfig does NOT update provider/secret when !captcha.Enabled
    // so remote copy gets enabled=true, provider="hcaptcha", secret unchanged (from local = "turnstile"/"ed64…")
    expect(diffAuth(remote, local)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -28,7 +28,7 @@",
        " web3 = 0",
        " ",
        " [captcha]",
        "-enabled = true",
        "+enabled = false",
        ' provider = "turnstile"',
        ' secret = "hash:ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e"',
        " ",
      ),
    );
  });

  it("local enabled remote disabled — matches golden diff", () => {
    const local = bareAuth({
      captcha: {
        enabled: true,
        provider: "turnstile",
        secret: "hash:ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e",
      },
    });
    const remote = withRemote(local, {
      security_captcha_enabled: false,
      security_captcha_provider: "hcaptcha",
      security_captcha_secret: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
    });
    expect(diffAuth(remote, local)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -28,9 +28,9 @@",
        " web3 = 0",
        " ",
        " [captcha]",
        "-enabled = false",
        '-provider = "hcaptcha"',
        '-secret = "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"',
        "+enabled = true",
        '+provider = "turnstile"',
        '+secret = "hash:ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e"',
        " ",
        " [hook]",
        " ",
      ),
    );
  });

  it("local and remote disabled — no diff", () => {
    const local = bareAuth({ captcha: { enabled: false, provider: "", secret: "" } });
    const remote = withRemote(local, { security_captcha_enabled: false });
    expect(diffAuth(remote, local)).toBe("");
  });

  it("ignores undefined captcha config — no diff", () => {
    const local = bareAuth(); // captcha = undefined
    const remote = withRemote(local, {
      security_captcha_enabled: true,
      security_captcha_provider: "hcaptcha",
      security_captcha_secret: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
    });
    expect(diffAuth(remote, local)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TestHookDiff
// ---------------------------------------------------------------------------

describe("TestHookDiff", () => {
  it("local and remote enabled — no diff", () => {
    const local = bareAuth({
      hook: {
        mfa_verification_attempt: {
          enabled: true,
          uri: "https://example.com",
          secrets: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
        },
        password_verification_attempt: {
          enabled: true,
          uri: "pg-functions://verifyPassword",
          secrets: "",
        },
        custom_access_token: {
          enabled: true,
          uri: "http://example.com",
          secrets: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
        },
        send_sms: {
          enabled: true,
          uri: "http://example.com",
          secrets: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
        },
        send_email: {
          enabled: true,
          uri: "https://example.com",
          secrets: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
        },
        before_user_created: {
          enabled: true,
          uri: "http://example.com",
          secrets: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
        },
      },
    });
    const remote = withRemote(local, {
      hook_mfa_verification_attempt_enabled: true,
      hook_mfa_verification_attempt_uri: "https://example.com",
      hook_mfa_verification_attempt_secrets:
        "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      hook_password_verification_attempt_enabled: true,
      hook_password_verification_attempt_uri: "pg-functions://verifyPassword",
      hook_custom_access_token_enabled: true,
      hook_custom_access_token_uri: "http://example.com",
      hook_custom_access_token_secrets:
        "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      hook_send_sms_enabled: true,
      hook_send_sms_uri: "http://example.com",
      hook_send_sms_secrets: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      hook_send_email_enabled: true,
      hook_send_email_uri: "https://example.com",
      hook_send_email_secrets: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      hook_before_user_created_enabled: true,
      hook_before_user_created_uri: "http://example.com",
      hook_before_user_created_secrets:
        "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
    });
    expect(diffAuth(remote, local)).toBe("");
  });

  it("local disabled remote enabled — matches golden diff", () => {
    const local = bareAuth({
      hook: {
        mfa_verification_attempt: {
          enabled: false,
          uri: "pg-functions://postgres/public/verifyMFA",
          secrets: "",
        },
        password_verification_attempt: undefined, // nil → omitted
        custom_access_token: { enabled: false, uri: "", secrets: "" },
        send_sms: {
          enabled: false,
          uri: "https://example.com",
          // local has Secret{Value:"test-secret"} with no SHA256 → hash:...
          // But test uses SHA256="" so secret field = "" after MarshalText
          secrets: "",
        },
        send_email: { enabled: false, uri: "", secrets: "" },
        before_user_created: { enabled: false, uri: "", secrets: "" },
      },
    });
    const remote = withRemote(local, {
      hook_mfa_verification_attempt_enabled: true,
      hook_mfa_verification_attempt_uri: "pg-functions://postgres/public/verifyMFA",
      hook_custom_access_token_enabled: true,
      hook_custom_access_token_uri: "http://example.com",
      hook_custom_access_token_secrets:
        "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      hook_send_sms_enabled: true,
      hook_send_sms_uri: "https://example.com",
      hook_send_sms_secrets: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      hook_send_email_enabled: true,
      hook_send_email_uri: "pg-functions://postgres/public/sendEmail",
      hook_before_user_created_enabled: true,
      hook_before_user_created_uri: "http://example.com",
      hook_before_user_created_secrets:
        "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      hook_password_verification_attempt_enabled: true,
      hook_password_verification_attempt_uri: "https://example.com",
      hook_password_verification_attempt_secrets:
        "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
    });
    expect(diffAuth(remote, local)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -29,23 +29,23 @@",
        " ",
        " [hook]",
        " [hook.mfa_verification_attempt]",
        "-enabled = true",
        "+enabled = false",
        ' uri = "pg-functions://postgres/public/verifyMFA"',
        ' secrets = ""',
        " [hook.custom_access_token]",
        "-enabled = true",
        "+enabled = false",
        ' uri = ""',
        ' secrets = ""',
        " [hook.send_sms]",
        "-enabled = true",
        "+enabled = false",
        ' uri = "https://example.com"',
        ' secrets = ""',
        " [hook.send_email]",
        "-enabled = true",
        "+enabled = false",
        ' uri = ""',
        ' secrets = ""',
        " [hook.before_user_created]",
        "-enabled = true",
        "+enabled = false",
        ' uri = ""',
        ' secrets = ""',
        " ",
      ),
    );
  });

  it("local enabled remote disabled — matches golden diff", () => {
    const local = bareAuth({
      hook: {
        mfa_verification_attempt: {
          enabled: true,
          uri: "pg-functions://postgres/public/verifyMFA",
          secrets: "",
        },
        password_verification_attempt: undefined,
        custom_access_token: {
          enabled: true,
          uri: "http://example.com",
          secrets: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
        },
        send_sms: {
          enabled: true,
          uri: "https://example.com",
          secrets: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
        },
        send_email: {
          enabled: true,
          uri: "pg-functions://postgres/public/sendEmail",
          secrets: "",
        },
        before_user_created: {
          enabled: true,
          uri: "http://example.com",
          secrets: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
        },
      },
    });
    const remote = withRemote(local, {
      hook_mfa_verification_attempt_enabled: false,
      hook_mfa_verification_attempt_uri: "pg-functions://postgres/public/verifyMFA",
      hook_custom_access_token_enabled: false,
      hook_custom_access_token_uri: "pg-functions://postgres/public/customToken",
      hook_send_sms_enabled: false,
      hook_send_sms_uri: "https://example.com",
      hook_send_sms_secrets: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      hook_send_email_enabled: false,
      hook_send_email_uri: "https://example.com",
      hook_send_email_secrets: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      hook_before_user_created_enabled: false,
      hook_before_user_created_uri: "pg-functions://postgres/public/beforeUserCreated",
      hook_password_verification_attempt_enabled: false,
    });
    expect(diffAuth(remote, local)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -29,25 +29,25 @@",
        " ",
        " [hook]",
        " [hook.mfa_verification_attempt]",
        "-enabled = false",
        "+enabled = true",
        ' uri = "pg-functions://postgres/public/verifyMFA"',
        ' secrets = ""',
        " [hook.custom_access_token]",
        "-enabled = false",
        '-uri = "pg-functions://postgres/public/customToken"',
        '-secrets = ""',
        "+enabled = true",
        '+uri = "http://example.com"',
        '+secrets = "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"',
        " [hook.send_sms]",
        "-enabled = false",
        "+enabled = true",
        ' uri = "https://example.com"',
        ' secrets = "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"',
        " [hook.send_email]",
        "-enabled = false",
        '-uri = "https://example.com"',
        "+enabled = true",
        '+uri = "pg-functions://postgres/public/sendEmail"',
        ' secrets = ""',
        " [hook.before_user_created]",
        "-enabled = false",
        '-uri = "pg-functions://postgres/public/beforeUserCreated"',
        '-secrets = ""',
        "+enabled = true",
        '+uri = "http://example.com"',
        '+secrets = "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"',
        " ",
        " [mfa]",
        " max_enrolled_factors = 0",
      ),
    );
  });

  it("local and remote disabled — no diff", () => {
    const local = bareAuth({
      hook: {
        mfa_verification_attempt: { enabled: false, uri: "", secrets: "" },
        password_verification_attempt: { enabled: false, uri: "", secrets: "" },
        custom_access_token: { enabled: false, uri: "", secrets: "" },
        send_sms: { enabled: false, uri: "", secrets: "" },
        send_email: { enabled: false, uri: "", secrets: "" },
        before_user_created: { enabled: false, uri: "", secrets: "" },
      },
    });
    const remote = withRemote(local, {
      hook_mfa_verification_attempt_enabled: false,
      hook_custom_access_token_enabled: false,
      hook_send_sms_enabled: false,
      hook_send_email_enabled: false,
      hook_before_user_created_enabled: false,
      hook_password_verification_attempt_enabled: false,
    });
    expect(diffAuth(remote, local)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TestMfaDiff
// ---------------------------------------------------------------------------

describe("TestMfaDiff", () => {
  it("local and remote enabled — no diff", () => {
    const local = bareAuth({
      mfa: {
        max_enrolled_factors: 10,
        totp: { enroll_enabled: true, verify_enabled: true },
        phone: {
          enroll_enabled: true,
          verify_enabled: true,
          otp_length: 6,
          template: "Your code is {{ .Code }}",
          max_frequency: "5s",
        },
        web_authn: { enroll_enabled: true, verify_enabled: true },
      },
    });
    const remote = withRemote(local, {
      mfa_max_enrolled_factors: 10,
      mfa_totp_enroll_enabled: true,
      mfa_totp_verify_enabled: true,
      mfa_phone_enroll_enabled: true,
      mfa_phone_verify_enabled: true,
      mfa_phone_otp_length: 6,
      mfa_phone_template: "Your code is {{ .Code }}",
      mfa_phone_max_frequency: 5,
      mfa_web_authn_enroll_enabled: true,
      mfa_web_authn_verify_enabled: true,
    });
    expect(diffAuth(remote, local)).toBe("");
  });

  it("local enabled and disabled — matches golden diff", () => {
    const local = bareAuth({
      mfa: {
        max_enrolled_factors: 0,
        totp: { enroll_enabled: false, verify_enabled: false },
        phone: {
          enroll_enabled: true,
          verify_enabled: true,
          otp_length: 0,
          template: "",
          max_frequency: "0s",
        },
        web_authn: { enroll_enabled: false, verify_enabled: false },
      },
    });
    const remote = withRemote(local, {
      mfa_max_enrolled_factors: 10,
      mfa_totp_enroll_enabled: false,
      mfa_totp_verify_enabled: false,
      mfa_phone_enroll_enabled: false,
      mfa_phone_verify_enabled: false,
      mfa_phone_otp_length: 6,
      mfa_phone_template: "Your code is {{ .Code }}",
      mfa_phone_max_frequency: 5,
      mfa_web_authn_enroll_enabled: false,
      mfa_web_authn_verify_enabled: false,
    });
    expect(diffAuth(remote, local)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -30,16 +30,16 @@",
        " [hook]",
        " ",
        " [mfa]",
        "-max_enrolled_factors = 10",
        "+max_enrolled_factors = 0",
        " [mfa.totp]",
        " enroll_enabled = false",
        " verify_enabled = false",
        " [mfa.phone]",
        "-enroll_enabled = false",
        "-verify_enabled = false",
        "-otp_length = 6",
        '-template = "Your code is {{ .Code }}"',
        '-max_frequency = "5s"',
        "+enroll_enabled = true",
        "+verify_enabled = true",
        "+otp_length = 0",
        '+template = ""',
        '+max_frequency = "0s"',
        " [mfa.web_authn]",
        " enroll_enabled = false",
        " verify_enabled = false",
      ),
    );
  });

  it("local and remote disabled — no diff", () => {
    const local = bareAuth({
      mfa: {
        max_enrolled_factors: 10,
        totp: { enroll_enabled: false, verify_enabled: false },
        phone: {
          enroll_enabled: false,
          verify_enabled: false,
          otp_length: 6,
          template: "Your code is {{ .Code }}",
          max_frequency: "5s",
        },
        web_authn: { enroll_enabled: false, verify_enabled: false },
      },
    });
    const remote = withRemote(local, {
      mfa_max_enrolled_factors: 10,
      mfa_totp_enroll_enabled: false,
      mfa_totp_verify_enabled: false,
      mfa_phone_enroll_enabled: false,
      mfa_phone_verify_enabled: false,
      mfa_phone_otp_length: 6,
      mfa_phone_template: "Your code is {{ .Code }}",
      mfa_phone_max_frequency: 5,
      mfa_web_authn_enroll_enabled: false,
      mfa_web_authn_verify_enabled: false,
    });
    expect(diffAuth(remote, local)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TestSmsDiff
// ---------------------------------------------------------------------------

describe("TestSmsDiff", () => {
  it("local disabled remote enabled — matches golden diff", () => {
    // Go's newWithDefaults() has enable_signup=true, TestOTP={}
    const local = bareAuth({ enable_signup: true }); // sms = defaults (all disabled)
    const remote = withRemote(local, {
      external_phone_enabled: true,
      sms_autoconfirm: true,
      sms_max_frequency: 60,
      sms_template: "Your code is {{ .Code }}",
      sms_test_otp: "123=456,456=123",
      sms_provider: "twilio",
      sms_twilio_account_sid: "test-account",
      sms_twilio_auth_token: "c84443bc59b92caef8ec8500ff443584793756749523811eb333af2bbc74fc88",
      sms_twilio_message_service_sid: "test-service",
    });
    expect(diffAuth(remote, local)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -58,12 +58,12 @@",
        " otp_expiry = 0",
        " ",
        " [sms]",
        "-enable_signup = true",
        "-enable_confirmations = true",
        '-template = "Your code is {{ .Code }}"',
        '-max_frequency = "1m0s"',
        "+enable_signup = false",
        "+enable_confirmations = false",
        '+template = ""',
        '+max_frequency = "0s"',
        " [sms.twilio]",
        "-enabled = true",
        "+enabled = false",
        ' account_sid = ""',
        ' message_service_sid = ""',
        ' auth_token = ""',
        "@@ -86,8 +86,6 @@",
        ' api_key = ""',
        ' api_secret = ""',
        " [sms.test_otp]",
        '-123 = "456"',
        '-456 = "123"',
        " ",
        " [web3]",
        " [web3.solana]",
      ),
    );
  });

  it("local enabled remote disabled — matches golden diff", () => {
    const local = bareAuth({
      enable_signup: true,
      sms: {
        enable_signup: true,
        enable_confirmations: true,
        template: "Your code is {{ .Code }}",
        max_frequency: "1m0s",
        twilio: { enabled: false, account_sid: "", message_service_sid: "", auth_token: "" },
        twilio_verify: { enabled: false, account_sid: "", message_service_sid: "", auth_token: "" },
        messagebird: {
          enabled: true,
          originator: "test-originator",
          access_key: "hash:ab60d03fc809fb02dae838582f3ddc13d1d6cb32ffba77c4b969dd3caa496f13",
        },
        textlocal: { enabled: false, sender: "", api_key: "" },
        vonage: { enabled: false, from: "", api_key: "", api_secret: "" },
        test_otp: { "123": "456" },
      },
    });
    const remote = withRemote(local, {
      external_phone_enabled: false,
      sms_autoconfirm: false,
      sms_max_frequency: 0,
      sms_template: "",
      sms_provider: "twilio",
      sms_twilio_account_sid: "test-account",
      sms_twilio_auth_token: "c84443bc59b92caef8ec8500ff443584793756749523811eb333af2bbc74fc88",
      sms_twilio_message_service_sid: "test-service",
    });
    expect(diffAuth(remote, local)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -58,12 +58,12 @@",
        " otp_expiry = 0",
        " ",
        " [sms]",
        "-enable_signup = false",
        "-enable_confirmations = false",
        '-template = ""',
        '-max_frequency = "0s"',
        "+enable_signup = true",
        "+enable_confirmations = true",
        '+template = "Your code is {{ .Code }}"',
        '+max_frequency = "1m0s"',
        " [sms.twilio]",
        "-enabled = true",
        "+enabled = false",
        ' account_sid = ""',
        ' message_service_sid = ""',
        ' auth_token = ""',
        "@@ -73,9 +73,9 @@",
        ' message_service_sid = ""',
        ' auth_token = ""',
        " [sms.messagebird]",
        "-enabled = false",
        '-originator = ""',
        '-access_key = ""',
        "+enabled = true",
        '+originator = "test-originator"',
        '+access_key = "hash:ab60d03fc809fb02dae838582f3ddc13d1d6cb32ffba77c4b969dd3caa496f13"',
        " [sms.textlocal]",
        " enabled = false",
        ' sender = ""',
        "@@ -86,6 +86,7 @@",
        ' api_key = ""',
        ' api_secret = ""',
        " [sms.test_otp]",
        '+123 = "456"',
        " ",
        " [web3]",
        " [web3.solana]",
      ),
    );
  });

  it("enable sign up without provider — matches golden diff", () => {
    // newWithDefaults() + EnableSignup = true (sms otherwise default)
    const local = bareAuth({
      enable_signup: true,
      sms: bareAuth().sms,
    });
    const smsLocal = { ...local.sms, enable_signup: true };
    const localWithSmsSignup = { ...local, sms: smsLocal };
    const remote = withRemote(localWithSmsSignup, {
      external_phone_enabled: false,
      sms_provider: "twilio",
    });
    expect(diffAuth(remote, localWithSmsSignup)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -58,7 +58,7 @@",
        " otp_expiry = 0",
        " ",
        " [sms]",
        "-enable_signup = false",
        "+enable_signup = true",
        " enable_confirmations = false",
        ' template = ""',
        ' max_frequency = "0s"',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// TestRateLimitsDiff
// ---------------------------------------------------------------------------

describe("TestRateLimitsDiff", () => {
  it("local and remote rate limits match — no diff", () => {
    const local = bareAuth({
      rate_limit: {
        anonymous_users: 20,
        token_refresh: 30,
        sign_in_sign_ups: 40,
        token_verifications: 50,
        email_sent: 25,
        sms_sent: 35,
        web3: 0,
      },
      email: {
        ...bareAuth().email,
        smtp: {
          enabled: true,
          host: "",
          port: 0,
          user: "",
          pass: "",
          admin_email: "",
          sender_name: "",
        },
      },
    });
    const remote = withRemote(local, {
      rate_limit_anonymous_users: 20,
      rate_limit_token_refresh: 30,
      rate_limit_otp: 40,
      rate_limit_verify: 50,
      rate_limit_email_sent: 25,
      rate_limit_sms_sent: 35,
      smtp_host: "",
    });
    expect(diffAuth(remote, local)).toBe("");
  });

  it("local and remote rate limits differ — matches golden diff", () => {
    const local = bareAuth({
      rate_limit: {
        anonymous_users: 20,
        token_refresh: 30,
        sign_in_sign_ups: 40,
        token_verifications: 50,
        email_sent: 25,
        sms_sent: 35,
        web3: 0,
      },
      email: {
        ...bareAuth().email,
        smtp: {
          enabled: true,
          host: "",
          port: 0,
          user: "",
          pass: "",
          admin_email: "",
          sender_name: "",
        },
      },
    });
    const remote = withRemote(local, {
      rate_limit_anonymous_users: 10,
      rate_limit_token_refresh: 30,
      rate_limit_otp: 45,
      rate_limit_verify: 50,
      rate_limit_email_sent: 15,
      rate_limit_sms_sent: 55,
      smtp_host: "",
    });
    expect(diffAuth(remote, local)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -19,12 +19,12 @@",
        ' service_role_key = ""',
        " ",
        " [rate_limit]",
        "-anonymous_users = 10",
        "+anonymous_users = 20",
        " token_refresh = 30",
        "-sign_in_sign_ups = 45",
        "+sign_in_sign_ups = 40",
        " token_verifications = 50",
        "-email_sent = 15",
        "-sms_sent = 55",
        "+email_sent = 25",
        "+sms_sent = 35",
        " web3 = 0",
        " ",
        " [hook]",
      ),
    );
  });

  it("ignores email rate limit when smtp is disabled — no diff", () => {
    const local = bareAuth({
      rate_limit: { ...bareAuth().rate_limit, email_sent: 25 },
      // smtp = undefined → disabled
    });
    const remote = withRemote(local, {
      rate_limit_email_sent: 15,
      smtp_host: "",
    });
    expect(diffAuth(remote, local)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TestExternalDiff
// ---------------------------------------------------------------------------

describe("TestExternalDiff", () => {
  it("local and remote enabled — no diff", () => {
    const allEnabled: Record<
      string,
      {
        enabled: boolean;
        client_id: string;
        secret: string;
        url: string;
        redirect_uri: string;
        skip_nonce_check: boolean;
        email_optional: boolean;
      }
    > = {};
    const providers = [
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
    ];
    for (const p of providers) {
      allEnabled[p] = {
        enabled: true,
        client_id: "",
        secret: "",
        url: "",
        redirect_uri: "",
        skip_nonce_check: false,
        email_optional: false,
      };
    }
    const local = bareAuth({ external: allEnabled });
    const remote = withRemote(local, {
      external_apple_enabled: true,
      external_apple_client_id: "",
      external_apple_additional_client_ids: "",
      external_apple_secret: "",
      external_azure_enabled: true,
      external_azure_client_id: "",
      external_azure_secret: "",
      external_azure_url: "",
      external_bitbucket_enabled: true,
      external_bitbucket_client_id: "",
      external_bitbucket_secret: "",
      external_discord_enabled: true,
      external_discord_client_id: "",
      external_discord_secret: "",
      external_facebook_enabled: true,
      external_facebook_client_id: "",
      external_facebook_secret: "",
      external_figma_enabled: true,
      external_figma_client_id: "",
      external_figma_secret: "",
      external_github_enabled: true,
      external_github_client_id: "",
      external_github_secret: "",
      external_gitlab_enabled: true,
      external_gitlab_client_id: "",
      external_gitlab_secret: "",
      external_gitlab_url: "",
      external_google_enabled: true,
      external_google_client_id: "",
      external_google_additional_client_ids: "",
      external_google_secret: "",
      external_google_skip_nonce_check: false,
      external_kakao_enabled: true,
      external_kakao_client_id: "",
      external_kakao_secret: "",
      external_keycloak_enabled: true,
      external_keycloak_client_id: "",
      external_keycloak_secret: "",
      external_keycloak_url: "",
      external_linkedin_oidc_enabled: true,
      external_linkedin_oidc_client_id: "",
      external_linkedin_oidc_secret: "",
      external_notion_enabled: true,
      external_notion_client_id: "",
      external_notion_secret: "",
      external_slack_oidc_enabled: true,
      external_slack_oidc_client_id: "",
      external_slack_oidc_secret: "",
      external_spotify_enabled: true,
      external_spotify_client_id: "",
      external_spotify_secret: "",
      external_twitch_enabled: true,
      external_twitch_client_id: "",
      external_twitch_secret: "",
      external_twitter_enabled: true,
      external_twitter_client_id: "",
      external_twitter_secret: "",
      external_x_enabled: true,
      external_x_client_id: "",
      external_x_secret: "",
      external_workos_enabled: true,
      external_workos_client_id: "",
      external_workos_secret: "",
      external_workos_url: "",
      external_zoom_enabled: true,
      external_zoom_client_id: "",
      external_zoom_secret: "",
    });
    expect(diffAuth(remote, local)).toBe("");
  });

  it("local enabled and disabled — matches golden diff", () => {
    const local = bareAuth({
      external: {
        apple: {
          enabled: true,
          client_id: "test-client-1,test-client-2",
          secret: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        azure: {
          enabled: true,
          client_id: "test-client-1",
          secret: "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        bitbucket: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        discord: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        facebook: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        figma: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        github: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        gitlab: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        google: {
          enabled: false,
          client_id: "test-client-2",
          secret: "", // env(test_secret) → no SHA256 → "" after MarshalText
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        keycloak: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        linkedin_oidc: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        notion: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        slack_oidc: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        spotify: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        twitch: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        twitter: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        x: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        workos: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
        zoom: {
          enabled: false,
          client_id: "",
          secret: "",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
      },
    });
    const remote = withRemote(local, {
      external_apple_enabled: false,
      external_apple_client_id: "test-client-1",
      external_apple_additional_client_ids: "test-client-2",
      external_apple_secret: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
      external_google_enabled: true,
      external_google_client_id: "test-client-1",
      external_google_additional_client_ids: "test-client-2",
      external_google_secret: "b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad",
      external_google_skip_nonce_check: true,
    });
    expect(diffAuth(remote, local)).toBe(
      lines(
        "diff remote[auth] local[auth]",
        "--- remote[auth]",
        "+++ local[auth]",
        "@@ -89,7 +89,7 @@",
        " ",
        " [external]",
        " [external.apple]",
        "-enabled = false",
        "+enabled = true",
        ' client_id = "test-client-1,test-client-2"',
        ' secret = "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"',
        ' url = ""',
        "@@ -97,9 +97,9 @@",
        " skip_nonce_check = false",
        " email_optional = false",
        " [external.azure]",
        "-enabled = false",
        '-client_id = ""',
        '-secret = ""',
        "+enabled = true",
        '+client_id = "test-client-1"',
        '+secret = "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"',
        ' url = ""',
        ' redirect_uri = ""',
        " skip_nonce_check = false",
        "@@ -153,7 +153,7 @@",
        " skip_nonce_check = false",
        " email_optional = false",
        " [external.google]",
        "-enabled = true",
        "+enabled = false",
        ' client_id = "test-client-2"',
        ' secret = ""',
        ' url = ""',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// authToUpdateBody — secret round-trip (regression: must send raw values, not hashes)
// ---------------------------------------------------------------------------

describe("authToUpdateBody secrets", () => {
  it("sends the raw plaintext secret value, not the hash (Go Secret.Value)", () => {
    const local = bareAuth({
      enabled: true,
      captcha: { enabled: true, provider: "hcaptcha", secret: "hash:abc123" },
      external: {
        github: {
          enabled: true,
          client_id: "cid",
          secret: "hash:def456",
          url: "",
          redirect_uri: "",
          skip_nonce_check: false,
          email_optional: false,
        },
      },
      rawSecrets: {
        captcha: "my-captcha-plaintext",
        hooks: {},
        smtp_pass: "",
        sms: { twilio: "", twilio_verify: "", messagebird: "", textlocal: "", vonage: "" },
        providers: { github: "my-github-plaintext" },
      },
    });
    const body = authToUpdateBody(local);
    expect(body["security_captcha_secret"]).toBe("my-captcha-plaintext");
    expect(body["external_github_secret"]).toBe("my-github-plaintext");
    // Never the hashed form.
    expect(body["security_captcha_secret"]).not.toContain("hash:");
    expect(body["external_github_secret"]).not.toContain("hash:");
  });

  it("omits the secret entirely when the hashed field is empty (unset / unresolved env)", () => {
    const local = bareAuth({
      enabled: true,
      captcha: { enabled: true, provider: "hcaptcha", secret: "" },
    });
    const body = authToUpdateBody(local);
    expect("security_captcha_secret" in body).toBe(false);
  });

  it("never pushes dotenvx ciphertext (encrypted: hashes to '' so the gate drops it)", () => {
    // secretHash returns "" for `encrypted:` values, so the projected captcha
    // secret is empty even though the raw (ciphertext) value is still present.
    // The empty hash must gate the ciphertext out of the update body.
    const local = bareAuth({
      enabled: true,
      captcha: { enabled: true, provider: "hcaptcha", secret: "" },
      rawSecrets: {
        captcha: "encrypted:BvEYU1pXk9ciphertext",
        hooks: {},
        smtp_pass: "",
        sms: { twilio: "", twilio_verify: "", messagebird: "", textlocal: "", vonage: "" },
        providers: {},
      },
    });
    const body = authToUpdateBody(local);
    expect("security_captcha_secret" in body).toBe(false);
    expect(Object.values(body)).not.toContain("encrypted:BvEYU1pXk9ciphertext");
  });

  it("sets sms_test_otp_valid_until to a calendar-exact 10 years out (Go AddDate(10,0,0))", () => {
    const local = bareAuth({
      enabled: true,
      sms: { ...bareAuth().sms, test_otp: { "123456": "654321" } },
    });
    const body = authToUpdateBody(local);
    const validUntil = new Date(String(body["sms_test_otp_valid_until"]));
    // Recompute the expected value the same way the handler does; allow a small
    // delta for the clock advancing between the two `new Date()` calls.
    const expected = new Date();
    expected.setUTCFullYear(expected.getUTCFullYear() + 10);
    expect(Math.abs(validUntil.getTime() - expected.getTime())).toBeLessThan(5_000);
    // Flat 3650-day arithmetic would be ~2-3 days short of the calendar value.
    const flat3650 = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    expect(validUntil.getTime() - flat3650).toBeGreaterThan(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// password_required_characters mapping
//
// Regression for the Go const-name-vs-API-value bug: the port must map the
// local `password_requirements` enum to the real API values (with `:`
// separators between character-class groups), NOT the oapi-codegen constant
// *names*. The API values below are copied from the generated
// `V1UpdateAuthServiceConfigInput` `password_required_characters` literals.
// ---------------------------------------------------------------------------

describe("password_required_characters mapping", () => {
  /** A valid disabled `RemoteAuthConfig`; only `password_required_characters` varies. */
  const baseRemote: RemoteAuthConfig = {
    site_url: "",
    uri_allow_list: "",
    jwt_exp: 0,
    refresh_token_rotation_enabled: false,
    security_refresh_token_reuse_interval: 0,
    security_manual_linking_enabled: false,
    disable_signup: true,
    external_anonymous_users_enabled: false,
    password_min_length: 0,
    password_required_characters: "",
  };

  // [local enum, API value] pairs — API values must match the generated schema literals.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["", ""],
    ["letters_digits", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789"],
    [
      "lower_upper_letters_digits",
      "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
    ],
    [
      "lower_upper_letters_digits_symbols",
      "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
    ],
  ];

  it.each(cases)(
    "%s round-trips through the update body and remote projection",
    (req, apiValue) => {
      // local enum → update body (Go ToChar)
      expect(
        authToUpdateBody(bareAuth({ password_requirements: req })).password_required_characters,
      ).toBe(apiValue);
      // remote API value → local enum (Go NewPasswordRequirement)
      expect(
        applyRemoteAuthConfig(bareAuth(), { ...baseRemote, password_required_characters: apiValue })
          .password_requirements,
      ).toBe(req);
    },
  );

  it("emits update-body values the generated client accepts", () => {
    for (const [req] of cases) {
      const value = authToUpdateBody(
        bareAuth({ password_requirements: req }),
      ).password_required_characters;
      const decoded = Schema.decodeUnknownExit(V1UpdateAuthServiceConfigInput)(
        { ref: "a".repeat(20), password_required_characters: value },
        { errors: "all" },
      );
      expect(Exit.isSuccess(decoded)).toBe(true);
    }
  });

  it("maps an unrecognised remote value to no requirement", () => {
    // The pre-fix bug used this oapi-codegen constant *name* (no separators) as a value.
    expect(
      applyRemoteAuthConfig(bareAuth(), {
        ...baseRemote,
        password_required_characters:
          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      }).password_requirements,
    ).toBe("");
  });
});
