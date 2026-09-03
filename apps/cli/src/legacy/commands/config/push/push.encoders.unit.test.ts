/**
 * Unit tests for push.encoders.ts.
 */

import type { CliConfig, ProjectConfig } from "@supabase/config";
import { getDefaultCliConfig } from "@supabase/config";
import type { ConfigChange } from "@supabase/config/internal";
import { describe, expect, it } from "vitest";

import type { LegacyAuthEmailContent } from "./push.auth-email-content.ts";
import {
  legacyEncodeApiBody,
  legacyEncodeAuthBody,
  legacyEncodeDbSettingsBody,
  legacyEncodeNetworkRestrictionsBody,
  legacyEncodeSslEnforcementBody,
  legacyEncodeStorageBody,
  type LegacyAuthEncoderInput,
  type LegacyPushEncoderInput,
} from "./push.encoders.ts";
import type { LegacyPushSecretDecision } from "./push.secrets.ts";

function change(path: ReadonlyArray<string>, local: unknown, remote: unknown = "remote"): ConfigChange {
  return { path, class: "update", local, remote, declared: true };
}

const EMPTY_EMAIL_CONTENT: LegacyAuthEmailContent = { template: {}, notification: {} };

function authInput(overrides: Partial<LegacyAuthEncoderInput> = {}): LegacyAuthEncoderInput {
  return {
    changes: [],
    local: {},
    config: getDefaultCliConfig(),
    secrets: [],
    emailContent: EMPTY_EMAIL_CONTENT,
    remoteAuthAttributes: {},
    now: new Date("2030-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("legacyEncodeApiBody", () => {
  function input(overrides: Partial<LegacyPushEncoderInput> = {}): LegacyPushEncoderInput {
    return { changes: [], local: {}, config: getDefaultCliConfig(), ...overrides };
  }

  it("is up to date (body undefined) when nothing routed to it changed", () => {
    const result = legacyEncodeApiBody(input());
    expect(result.body).toBeUndefined();
    expect(result.encoded).toEqual([]);
    expect(result.unencodable).toEqual([]);
  });

  it("ships only the changed key (max_rows)", () => {
    const result = legacyEncodeApiBody(input({ changes: [change(["api", "max_rows"], 2000)] }));
    expect(result.body).toEqual({ max_rows: 2000 });
    expect(result.encoded).toEqual([["api", "max_rows"]]);
  });

  it("joins extra_search_path, empty allowed", () => {
    const result = legacyEncodeApiBody(input({ changes: [change(["api", "extra_search_path"], [])] }));
    expect(result.body).toEqual({ db_extra_search_path: "" });
  });

  it("disabling sends db_schema: '' ", () => {
    const result = legacyEncodeApiBody(
      input({ changes: [change(["api", "enabled"], false)], local: { api: { enabled: false } } }),
    );
    expect(result.body).toEqual({ db_schema: "" });
    expect(result.encoded).toEqual([["api", "enabled"]]);
  });

  it("enabling joins the local schemas", () => {
    const result = legacyEncodeApiBody(
      input({
        changes: [change(["api", "enabled"], true)],
        local: { api: { enabled: true, schemas: ["public", "graphql_public"] } },
      }),
    );
    expect(result.body).toEqual({ db_schema: "public,graphql_public" });
  });

  it("schemas changing alone joins them", () => {
    const result = legacyEncodeApiBody(
      input({
        changes: [change(["api", "schemas"], ["public", "private"])],
        local: { api: { enabled: true, schemas: ["public", "private"] } },
      }),
    );
    expect(result.body).toEqual({ db_schema: "public,private" });
  });

  it("empty schemas is unencodable", () => {
    const result = legacyEncodeApiBody(
      input({
        changes: [change(["api", "schemas"], [])],
        local: { api: { enabled: true, schemas: [] } },
      }),
    );
    expect(result.body).toBeUndefined();
    expect(result.unencodable).toEqual([["api", "schemas"]]);
  });

  it("enabling with no schemas is unencodable", () => {
    const result = legacyEncodeApiBody(
      input({
        changes: [change(["api", "enabled"], true)],
        local: { api: { enabled: true, schemas: [] } },
      }),
    );
    expect(result.body).toBeUndefined();
    expect(result.unencodable).toEqual([["api", "enabled"]]);
  });

  it("max_rows <= 0 is unencodable", () => {
    const result = legacyEncodeApiBody(input({ changes: [change(["api", "max_rows"], 0)] }));
    expect(result.body).toBeUndefined();
    expect(result.unencodable).toEqual([["api", "max_rows"]]);
  });
});

describe("legacyEncodeDbSettingsBody", () => {
  it("ships only the changed keys", () => {
    const result = legacyEncodeDbSettingsBody({
      changes: [
        change(["db", "settings", "shared_buffers"], "256MB"),
        change(["db", "settings", "max_connections"], 100),
        change(["db", "settings", "track_commit_timestamp"], true),
      ],
      local: {},
      config: getDefaultCliConfig(),
    });
    expect(result.body).toEqual({
      shared_buffers: "256MB",
      max_connections: 100,
      track_commit_timestamp: true,
    });
    expect(result.encoded).toHaveLength(3);
  });

  it("is up to date when nothing changed", () => {
    const result = legacyEncodeDbSettingsBody({ changes: [], local: {}, config: getDefaultCliConfig() });
    expect(result.body).toBeUndefined();
  });
});

describe("legacyEncodeNetworkRestrictionsBody", () => {
  it("sends both CIDR arrays together, triggered by either one changing", () => {
    const local: ProjectConfig = {
      db: { network_restrictions: { allowed_cidrs: ["10.0.0.0/8"], allowed_cidrs_v6: ["::/0"] } },
    };
    const result = legacyEncodeNetworkRestrictionsBody({
      changes: [change(["db", "network_restrictions", "allowed_cidrs"], ["10.0.0.0/8"])],
      local,
      config: getDefaultCliConfig(),
    });
    expect(result.body).toEqual({ dbAllowedCidrs: ["10.0.0.0/8"], dbAllowedCidrsV6: ["::/0"] });
    expect(result.encoded).toEqual([["db", "network_restrictions", "allowed_cidrs"]]);
  });

  it("is up to date when nothing changed", () => {
    const result = legacyEncodeNetworkRestrictionsBody({
      changes: [],
      local: {},
      config: getDefaultCliConfig(),
    });
    expect(result.body).toBeUndefined();
  });
});

describe("legacyEncodeSslEnforcementBody", () => {
  it("wraps the boolean in requestedConfig.database", () => {
    const result = legacyEncodeSslEnforcementBody({
      changes: [change(["db", "ssl_enforcement", "enabled"], true)],
      local: {},
      config: getDefaultCliConfig(),
    });
    expect(result.body).toEqual({ requestedConfig: { database: true } });
    expect(result.encoded).toEqual([["db", "ssl_enforcement", "enabled"]]);
  });

  it("is up to date when nothing changed", () => {
    const result = legacyEncodeSslEnforcementBody({
      changes: [],
      local: {},
      config: getDefaultCliConfig(),
    });
    expect(result.body).toBeUndefined();
  });
});

describe("legacyEncodeStorageBody", () => {
  it("ships file_size_limit alone with features absent (sparseness proof)", () => {
    const result = legacyEncodeStorageBody({
      changes: [change(["storage", "file_size_limit"], "100MiB")],
      local: {},
      config: getDefaultCliConfig(),
    });
    expect(result.body).toEqual({ fileSizeLimit: 104_857_600, features: undefined });
    expect(result.encoded).toEqual([["storage", "file_size_limit"]]);
  });

  it("wraps image_transformation/s3_protocol as single-key containers", () => {
    const result = legacyEncodeStorageBody({
      changes: [
        change(["storage", "image_transformation", "enabled"], true),
        change(["storage", "s3_protocol", "enabled"], false),
      ],
      local: {},
      config: getDefaultCliConfig(),
    });
    expect(result.body).toEqual({
      fileSizeLimit: undefined,
      features: { imageTransformation: { enabled: true }, s3Protocol: { enabled: false } },
    });
  });

  it("ships the whole analytics (iceberg) container when any of its keys changed", () => {
    const local: ProjectConfig = {
      storage: { analytics: { enabled: true, max_namespaces: 5, max_tables: 10, max_catalogs: 2 } },
    };
    const result = legacyEncodeStorageBody({
      changes: [change(["storage", "analytics", "max_tables"], 10)],
      local,
      config: getDefaultCliConfig(),
    });
    expect(result.body?.features?.icebergCatalog).toEqual({
      enabled: true,
      maxNamespaces: 5,
      maxTables: 10,
      maxCatalogs: 2,
    });
    expect(result.encoded).toEqual([["storage", "analytics", "max_tables"]]);
  });

  it("ships the whole vector container when any of its keys changed", () => {
    const local: ProjectConfig = {
      storage: { vector: { enabled: true, max_buckets: 10, max_indexes: 5 } },
    };
    const result = legacyEncodeStorageBody({
      changes: [change(["storage", "vector", "enabled"], true)],
      local,
      config: getDefaultCliConfig(),
    });
    expect(result.body?.features?.vectorBuckets).toEqual({
      enabled: true,
      maxBuckets: 10,
      maxIndexes: 5,
    });
  });

  it("emits {enabled:false, ...} for analytics, falling back to `config` for max_* the projection pruned", () => {
    const base = getDefaultCliConfig();
    const config: CliConfig = {
      ...base,
      storage: { ...base.storage, analytics: { enabled: false, max_namespaces: 7, max_tables: 3, max_catalogs: 1, buckets: {} } },
    };
    // The real pipeline drops a disabled `storage.analytics` from the local
    // projection entirely (`applyPushUnmanagedOmissions`) — this directly
    // exercises the encoder with that pruned shape, as a change constructed
    // by hand rather than through the full diff pipeline (CLI-2314 note).
    const result = legacyEncodeStorageBody({
      changes: [change(["storage", "analytics", "enabled"], false)],
      local: {},
      config,
    });
    expect(result.body?.features?.icebergCatalog).toEqual({
      enabled: false,
      maxNamespaces: 7,
      maxTables: 3,
      maxCatalogs: 1,
    });
  });

  it("emits {enabled:false, ...} for vector, falling back to `config` for max_* the projection pruned", () => {
    const base = getDefaultCliConfig();
    const config: CliConfig = {
      ...base,
      storage: { ...base.storage, vector: { enabled: false, max_buckets: 11, max_indexes: 6, buckets: {} } },
    };
    const result = legacyEncodeStorageBody({
      changes: [change(["storage", "vector", "enabled"], false)],
      local: {},
      config,
    });
    expect(result.body?.features?.vectorBuckets).toEqual({
      enabled: false,
      maxBuckets: 11,
      maxIndexes: 6,
    });
  });

  it("is up to date when nothing changed", () => {
    const result = legacyEncodeStorageBody({ changes: [], local: {}, config: getDefaultCliConfig() });
    expect(result.body).toBeUndefined();
  });
});

describe("legacyEncodeAuthBody", () => {
  it("is up to date (body undefined) when nothing routed to it changed and no secret sends", () => {
    const result = legacyEncodeAuthBody(authInput());
    expect(result.body).toBeUndefined();
    expect(result.encoded).toEqual([]);
  });

  it("joins additional_redirect_urls with a comma", () => {
    const result = legacyEncodeAuthBody(
      authInput({ changes: [change(["auth", "additional_redirect_urls"], ["a", "b"])] }),
    );
    expect(result.body).toEqual({ uri_allow_list: "a,b" });
  });

  it("inverts enable_signup into disable_signup", () => {
    const result = legacyEncodeAuthBody(authInput({ changes: [change(["auth", "enable_signup"], true)] }));
    expect(result.body).toEqual({ disable_signup: false });
  });

  it("inverts email.enable_confirmations into mailer_autoconfirm", () => {
    const result = legacyEncodeAuthBody(
      authInput({ changes: [change(["auth", "email", "enable_confirmations"], true)] }),
    );
    expect(result.body).toEqual({ mailer_autoconfirm: false });
  });

  it("maps password_requirements through the character-class table", () => {
    const result = legacyEncodeAuthBody(
      authInput({ changes: [change(["auth", "password_requirements"], "letters_digits")] }),
    );
    expect(result.body).toEqual({
      password_required_characters:
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
    });
  });

  it("floors mfa.phone.max_frequency to whole seconds", () => {
    const result = legacyEncodeAuthBody(
      authInput({ changes: [change(["auth", "mfa", "phone", "max_frequency"], "1500ms")] }),
    );
    expect(result.body).toEqual({ mfa_phone_max_frequency: 1 });
  });

  it("converts sessions.timebox to fractional hours (not floored)", () => {
    const result = legacyEncodeAuthBody(
      authInput({ changes: [change(["auth", "sessions", "timebox"], "1h30m")] }),
    );
    expect(result.body).toEqual({ sessions_timebox: 1.5 });
  });

  it("floors smtp_max_frequency (email.max_frequency) to whole seconds", () => {
    const result = legacyEncodeAuthBody(
      authInput({ changes: [change(["auth", "email", "max_frequency"], "1500ms")] }),
    );
    expect(result.body).toEqual({ smtp_max_frequency: 1 });
  });

  describe("smtp container", () => {
    it("disabled → only smtp_host: ''", () => {
      const local: ProjectConfig = { auth: { email: { smtp: { enabled: false } } } };
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "email", "smtp", "enabled"], false)], local }),
      );
      expect(result.body).toEqual({ smtp_host: "" });
    });

    it("enabled → the non-secret companion fields, port stringified", () => {
      const local: ProjectConfig = {
        auth: {
          email: {
            smtp: {
              enabled: true,
              host: "smtp.example.com",
              port: 587,
              user: "user",
              admin_email: "a@b.com",
              sender_name: "Sender",
            },
          },
        },
      };
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "email", "smtp", "host"], "smtp.example.com")], local }),
      );
      expect(result.body).toEqual({
        smtp_host: "smtp.example.com",
        smtp_port: "587",
        smtp_user: "user",
        smtp_admin_email: "a@b.com",
        smtp_sender_name: "Sender",
      });
    });

    it("triggered purely by a secret 'send' decision, with no ordinary field change", () => {
      const local: ProjectConfig = {
        auth: {
          email: {
            smtp: {
              enabled: true,
              host: "smtp.example.com",
              port: 587,
              user: "user",
              admin_email: "a@b.com",
              sender_name: "Sender",
            },
          },
        },
      };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        { path: ["auth", "email", "smtp", "pass"], apiKey: "smtp_pass", status: "send", plaintext: "hunter2" },
      ];
      const result = legacyEncodeAuthBody(authInput({ local, secrets }));
      expect(result.body).toEqual({
        smtp_host: "smtp.example.com",
        smtp_port: "587",
        smtp_user: "user",
        smtp_admin_email: "a@b.com",
        smtp_sender_name: "Sender",
        smtp_pass: "hunter2",
      });
      // No ConfigChange exists for a secret — nothing to report as "encoded".
      expect(result.encoded).toEqual([]);
    });

    it("withholds smtp_pass while unchanged/gated/not_set", () => {
      const local: ProjectConfig = { auth: { email: { smtp: { enabled: true, host: "h", port: 1 } } } };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        { path: ["auth", "email", "smtp", "pass"], apiKey: "smtp_pass", status: "unchanged" },
      ];
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "email", "smtp", "host"], "h")], local, secrets }),
      );
      expect(result.body).not.toHaveProperty("smtp_pass");
    });
  });

  describe("captcha container", () => {
    it("disabled → only security_captcha_enabled: false", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "captcha", "enabled"], false)],
          local: { auth: { captcha: { enabled: false } } },
        }),
      );
      expect(result.body).toEqual({ security_captcha_enabled: false });
    });

    it("enabled → provider ships, secret ships only while status is 'send'", () => {
      const local: ProjectConfig = { auth: { captcha: { enabled: true, provider: "hcaptcha" } } };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        {
          path: ["auth", "captcha", "secret"],
          apiKey: "security_captcha_secret",
          status: "send",
          plaintext: "shh",
        },
      ];
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "captcha", "provider"], "hcaptcha")], local, secrets }),
      );
      expect(result.body).toEqual({
        security_captcha_enabled: true,
        security_captcha_provider: "hcaptcha",
        security_captcha_secret: "shh",
      });
    });
  });

  describe("hook containers", () => {
    it("disabled → only hook_<name>_enabled: false", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "hook", "send_email", "enabled"], false)],
          local: { auth: { hook: { send_email: { enabled: false } } } },
        }),
      );
      expect(result.body).toEqual({ hook_send_email_enabled: false });
    });

    it("enabled → uri ships, secret ships only while status is 'send'", () => {
      const local: ProjectConfig = {
        auth: { hook: { send_email: { enabled: true, uri: "https://example.com/hook" } } },
      };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        {
          path: ["auth", "hook", "send_email", "secrets"],
          apiKey: "hook_send_email_secrets",
          status: "send",
          plaintext: "v1,whsec_abc",
        },
      ];
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "hook", "send_email", "uri"], "https://example.com/hook")],
          local,
          secrets,
        }),
      );
      expect(result.body).toEqual({
        hook_send_email_enabled: true,
        hook_send_email_uri: "https://example.com/hook",
        hook_send_email_secrets: "v1,whsec_abc",
      });
    });

    it("processes every one of the six known hooks independently", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [
            change(["auth", "hook", "before_user_created", "enabled"], false),
            change(["auth", "hook", "mfa_verification_attempt", "enabled"], false),
          ],
          local: {
            auth: {
              hook: {
                before_user_created: { enabled: false },
                mfa_verification_attempt: { enabled: false },
              },
            },
          },
        }),
      );
      expect(result.body).toEqual({
        hook_before_user_created_enabled: false,
        hook_mfa_verification_attempt_enabled: false,
      });
    });
  });

  describe("external provider containers", () => {
    it("disabled → only external_<id>_enabled: false", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "external", "github", "enabled"], false)],
          local: { auth: { external: { github: { enabled: false } } } },
        }),
      );
      expect(result.body).toEqual({ external_github_enabled: false });
    });

    it("enabled → client_id, email_optional, and secret-while-'send' ship", () => {
      const local: ProjectConfig = {
        auth: { external: { github: { enabled: true, client_id: "id", email_optional: true } } },
      };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        {
          path: ["auth", "external", "github", "secret"],
          apiKey: "external_github_secret",
          status: "send",
          plaintext: "gh-secret",
        },
      ];
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "external", "github", "client_id"], "id")], local, secrets }),
      );
      expect(result.body).toEqual({
        external_github_enabled: true,
        external_github_client_id: "id",
        external_github_secret: "gh-secret",
        external_github_email_optional: true,
      });
    });

    it("ships url only for azure/gitlab/keycloak/workos", () => {
      const local: ProjectConfig = {
        auth: {
          external: {
            azure: { enabled: true, client_id: "id", url: "https://azure.example.com", email_optional: false },
            github: { enabled: true, client_id: "id", email_optional: false },
          },
        },
      };
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [
            change(["auth", "external", "azure", "enabled"], true),
            change(["auth", "external", "github", "enabled"], true),
          ],
          local,
        }),
      );
      expect(result.body).toMatchObject({
        external_azure_url: "https://azure.example.com",
      });
      expect(result.body).not.toHaveProperty("external_github_url");
    });

    it("ships skip_nonce_check only for google", () => {
      const local: ProjectConfig = {
        auth: {
          external: {
            google: { enabled: true, client_id: "id", email_optional: false, skip_nonce_check: true },
            github: { enabled: true, client_id: "id", email_optional: false },
          },
        },
      };
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [
            change(["auth", "external", "google", "enabled"], true),
            change(["auth", "external", "github", "enabled"], true),
          ],
          local,
        }),
      );
      expect(result.body).toMatchObject({ external_google_skip_nonce_check: true });
      expect(result.body).not.toHaveProperty("external_github_skip_nonce_check");
    });

    it("ships a comma-containing apple/google client_id verbatim, never split", () => {
      const local: ProjectConfig = {
        auth: {
          external: {
            apple: { enabled: true, client_id: "id-1,id-2", email_optional: false },
          },
        },
      };
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "external", "apple", "client_id"], "id-1,id-2")], local }),
      );
      expect(result.body).toMatchObject({ external_apple_client_id: "id-1,id-2" });
      expect(result.body).not.toHaveProperty("external_apple_additional_client_ids");
    });

    it("triggers purely from a secret 'send' decision with no ordinary field change", () => {
      const local: ProjectConfig = {
        auth: { external: { github: { enabled: true, client_id: "id", email_optional: false } } },
      };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        {
          path: ["auth", "external", "github", "secret"],
          apiKey: "external_github_secret",
          status: "send",
          plaintext: "gh-secret",
        },
      ];
      const result = legacyEncodeAuthBody(authInput({ local, secrets }));
      expect(result.body).toEqual({
        external_github_enabled: true,
        external_github_client_id: "id",
        external_github_secret: "gh-secret",
        external_github_email_optional: false,
      });
      expect(result.encoded).toEqual([]);
    });
  });

  describe("dead passkey/webauthn keys", () => {
    it("are never emitted, even when routed changes cover every other auth field", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [
            change(["auth", "site_url"], "https://example.com"),
            change(["auth", "mfa", "totp", "enroll_enabled"], true),
          ],
        }),
      );
      const keys = Object.keys(result.body ?? {});
      expect(keys.some((key) => key.startsWith("passkey_"))).toBe(false);
      expect(keys.some((key) => key.startsWith("webauthn_"))).toBe(false);
    });
  });

  describe("sms test otp", () => {
    it("joins the map as K=V pairs and sets valid_until from the injected clock", () => {
      const local: ProjectConfig = {
        auth: { sms: { test_otp: { "+15555550100": "123456", "+15555550101": "654321" } } },
      };
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "sms", "test_otp", "+15555550100"], "123456")],
          local,
          now: new Date("2030-06-15T12:00:00.000Z"),
        }),
      );
      expect(result.body).toEqual({
        sms_test_otp: "+15555550100=123456,+15555550101=654321",
        sms_test_otp_valid_until: "2040-06-15T12:00:00.000Z",
      });
    });
  });

  describe("sms providers", () => {
    it("ships the active provider's credential set, secret only while 'send'", () => {
      const local: ProjectConfig = {
        auth: {
          sms: {
            twilio: { enabled: true, account_sid: "sid", message_service_sid: "svc" },
          },
        },
      };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        {
          path: ["auth", "sms", "twilio", "auth_token"],
          apiKey: "sms_twilio_auth_token",
          status: "send",
          plaintext: "token",
        },
      ];
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "sms", "twilio", "account_sid"], "sid")],
          local,
          secrets,
        }),
      );
      expect(result.body).toEqual({
        sms_provider: "twilio",
        sms_twilio_account_sid: "sid",
        sms_twilio_message_service_sid: "svc",
        sms_twilio_auth_token: "token",
      });
    });

    it("ships vonage's non-secret api_key alongside its secret api_secret", () => {
      const local: ProjectConfig = {
        auth: { sms: { vonage: { enabled: true, from: "from", api_key: "key" } } },
      };
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "sms", "vonage", "from"], "from")], local }),
      );
      expect(result.body).toEqual({
        sms_provider: "vonage",
        sms_vonage_api_key: "key",
        sms_vonage_from: "from",
      });
    });

    it("no provider enabled is unencodable", () => {
      const local: ProjectConfig = { auth: { sms: { twilio: { enabled: false } } } };
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "sms", "twilio", "enabled"], false)], local }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([["auth", "sms", "twilio", "enabled"]]);
    });
  });

  describe("push-only mailer content", () => {
    it("ships template content that differs from the remote key", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          emailContent: { template: { invite: "<h1>Invite</h1>" }, notification: {} },
          remoteAuthAttributes: { mailer_templates_invite_content: "<p>old</p>" },
        }),
      );
      expect(result.body).toEqual({ mailer_templates_invite_content: "<h1>Invite</h1>" });
      expect(result.encoded).toEqual([["auth", "email", "template", "invite", "content"]]);
    });

    it("omits template content that already matches the remote key", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          emailContent: { template: { invite: "<h1>Invite</h1>" }, notification: {} },
          remoteAuthAttributes: { mailer_templates_invite_content: "<h1>Invite</h1>" },
        }),
      );
      expect(result.body).toBeUndefined();
    });

    it("ships notification content only when loaded (enabled)", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          emailContent: { template: {}, notification: { password_changed: "<p>Changed</p>" } },
          remoteAuthAttributes: {},
        }),
      );
      expect(result.body).toEqual({
        mailer_templates_password_changed_notification_content: "<p>Changed</p>",
      });
      expect(result.encoded).toEqual([
        ["auth", "email", "notification", "password_changed", "content"],
      ]);
    });
  });

  it("web3 leaves are independent", () => {
    const result = legacyEncodeAuthBody(
      authInput({
        changes: [
          change(["auth", "web3", "solana", "enabled"], true),
          change(["auth", "web3", "ethereum", "enabled"], false),
        ],
      }),
    );
    expect(result.body).toEqual({
      external_web3_solana_enabled: true,
      external_web3_ethereum_enabled: false,
    });
  });
});
