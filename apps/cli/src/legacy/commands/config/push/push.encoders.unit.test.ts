/**
 * Unit tests for push.encoders.ts.
 */

import type { CliConfig, ProjectConfig } from "@supabase/config";
import { getDefaultCliConfig } from "@supabase/config";
import type { ConfigChange } from "@supabase/config/internal";
import { AUTH_HOOK_NAMES, projectConfigMappingRows } from "@supabase/config/internal";
import { describe, expect, it } from "vitest";

import type { LegacyAuthEmailContent } from "./push.auth-email-content.ts";
import {
  legacyEncodeApiBody,
  legacyEncodeAuthBody,
  legacyEncodeDbSettingsBody,
  legacyEncodeNetworkRestrictionsBody,
  legacyEncodeSslEnforcementBody,
  legacyEncodeStorageBody,
  LEGACY_PUSH_AUTH_LEAF_MAP,
  type LegacyAuthEncoderInput,
  type LegacyPushEncoderInput,
  type LegacyStorageEncoderInput,
} from "./push.encoders.ts";
import { legacySamePath } from "./push.paths.ts";
import {
  LEGACY_EMAIL_NOTIFICATION_NAMES,
  LEGACY_EMAIL_TEMPLATE_NAMES,
  LEGACY_EXTERNAL_PROVIDER_IDS,
  LEGACY_PROVIDERS_WITH_EMAIL_OPTIONAL,
  LEGACY_PROVIDERS_WITH_SKIP_NONCE_CHECK,
  LEGACY_PROVIDERS_WITH_URL,
} from "./push.registry-names.ts";
import type { LegacyPushSecretDecision } from "./push.secrets.ts";

function change(
  path: ReadonlyArray<string>,
  local: unknown,
  remote: unknown = "remote",
): ConfigChange {
  return { path, class: "update", local, remote, declared: true };
}

function secretDecision(
  overrides: Partial<LegacyPushSecretDecision> = {},
): LegacyPushSecretDecision {
  return { path: [], apiKey: "", status: "unchanged", remoteState: "absent", ...overrides };
}

const EMPTY_EMAIL_CONTENT: LegacyAuthEmailContent = { template: {}, notification: {} };

function input(overrides: Partial<LegacyPushEncoderInput> = {}): LegacyPushEncoderInput {
  return { changes: [], local: {}, remote: {}, ...overrides };
}

function storageInput(
  overrides: Partial<LegacyStorageEncoderInput> = {},
): LegacyStorageEncoderInput {
  return { changes: [], local: {}, remote: {}, config: getDefaultCliConfig(), ...overrides };
}

function authInput(overrides: Partial<LegacyAuthEncoderInput> = {}): LegacyAuthEncoderInput {
  return {
    changes: [],
    local: {},
    remote: {},
    secrets: [],
    emailContent: EMPTY_EMAIL_CONTENT,
    remoteAuthAttributes: {},
    now: new Date("2030-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("legacyEncodeApiBody", () => {
  it("is up to date (body undefined) when nothing routed to it changed", () => {
    const result = legacyEncodeApiBody(input());
    expect(result.body).toBeUndefined();
    expect(result.encoded).toEqual([]);
    expect(result.unencodable).toEqual([]);
    expect(result.forced).toEqual([]);
  });

  it("ships only the changed key (max_rows) — sparse body", () => {
    const result = legacyEncodeApiBody(input({ changes: [change(["api", "max_rows"], 2000)] }));
    expect(result.body).toEqual({ max_rows: 2000 });
    expect(Object.keys(result.body ?? {})).toEqual(["max_rows"]);
    expect(result.encoded).toEqual([["api", "max_rows"]]);
  });

  it("ships max_rows unconditionally, even a value <= 0 (upstream already normalizes that to unmanaged)", () => {
    const result = legacyEncodeApiBody(input({ changes: [change(["api", "max_rows"], 0)] }));
    expect(result.body).toEqual({ max_rows: 0 });
    expect(result.unencodable).toEqual([]);
  });

  it("joins extra_search_path, empty allowed", () => {
    const result = legacyEncodeApiBody(
      input({ changes: [change(["api", "extra_search_path"], [])] }),
    );
    expect(result.body).toEqual({ db_extra_search_path: "" });
    expect(Object.keys(result.body ?? {})).toEqual(["db_extra_search_path"]);
  });

  it("disabling sends db_schema: '' alone", () => {
    const result = legacyEncodeApiBody(
      input({ changes: [change(["api", "enabled"], false)], local: { api: { enabled: false } } }),
    );
    expect(result.body).toEqual({ db_schema: "" });
    expect(Object.keys(result.body ?? {})).toEqual(["db_schema"]);
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

  it("enabling with no schemas anywhere is unencodable, with the D5 reason", () => {
    const result = legacyEncodeApiBody(
      input({
        changes: [change(["api", "enabled"], true)],
        local: { api: { enabled: true, schemas: [] } },
      }),
    );
    expect(result.body).toBeUndefined();
    expect(result.unencodable).toEqual([
      {
        path: ["api", "enabled"],
        reason: "enabling the Data API needs at least one schema in api.schemas",
      },
    ]);
  });

  it("prefers the remote's current enabled state over local's default when only schemas changed", () => {
    const result = legacyEncodeApiBody(
      input({
        changes: [change(["api", "schemas"], ["public", "private"])],
        local: { api: { enabled: false, schemas: ["public", "private"] } },
        remote: { api: { enabled: true, schemas: ["public"] } },
      }),
    );
    // remote says enabled=true, so schemas ship even though local's own
    // `enabled` (a schema default the file never declared) says false.
    expect(result.body).toEqual({ db_schema: "public,private" });
    expect(result.forced).toEqual([]);
  });

  it("discloses a forced fallback to local when remote reports nothing for the enabled companion", () => {
    const result = legacyEncodeApiBody(
      input({
        changes: [change(["api", "schemas"], ["public", "private"])],
        local: { api: { enabled: true, schemas: ["public", "private"] } },
        remote: {},
      }),
    );
    expect(result.body).toEqual({ db_schema: "public,private" });
    expect(result.forced).toEqual([{ path: ["api", "enabled"], value: true }]);
  });
});

describe("legacyEncodeDbSettingsBody", () => {
  it("ships only the changed keys — sparse body", () => {
    const result = legacyEncodeDbSettingsBody(
      input({
        changes: [
          change(["db", "settings", "shared_buffers"], "256MB"),
          change(["db", "settings", "max_connections"], 100),
          change(["db", "settings", "track_commit_timestamp"], true),
        ],
      }),
    );
    expect(result.body).toEqual({
      shared_buffers: "256MB",
      max_connections: 100,
      track_commit_timestamp: true,
    });
    expect(Object.keys(result.body ?? {}).sort()).toEqual([
      "max_connections",
      "shared_buffers",
      "track_commit_timestamp",
    ]);
    expect(result.encoded).toHaveLength(3);
  });

  it("is up to date when nothing changed", () => {
    const result = legacyEncodeDbSettingsBody(input());
    expect(result.body).toBeUndefined();
  });

  it("rejects a change not shaped like db.settings.<key> as unencodable", () => {
    const result = legacyEncodeDbSettingsBody(
      input({ changes: [change(["db", "settings"], "256MB")] }),
    );
    expect(result.body).toBeUndefined();
    expect(result.unencodable).toEqual([
      {
        path: ["db", "settings"],
        reason:
          "only a top-level db.settings.<key> value can be encoded into a Postgres config write",
      },
    ]);
  });
});

describe("legacyEncodeNetworkRestrictionsBody", () => {
  it("sends both CIDR arrays together, triggered by either one changing", () => {
    const local: ProjectConfig = {
      db: { network_restrictions: { allowed_cidrs: ["10.0.0.0/8"], allowed_cidrs_v6: ["::/0"] } },
    };
    const result = legacyEncodeNetworkRestrictionsBody(
      input({
        changes: [change(["db", "network_restrictions", "allowed_cidrs"], ["10.0.0.0/8"])],
        local,
      }),
    );
    expect(result.body).toEqual({ dbAllowedCidrs: ["10.0.0.0/8"], dbAllowedCidrsV6: ["::/0"] });
    expect(result.encoded).toEqual([["db", "network_restrictions", "allowed_cidrs"]]);
  });

  it("keeps the remote's allowed_cidrs_v6 when it is undeclared locally", () => {
    const remote: ProjectConfig = {
      db: {
        network_restrictions: {
          allowed_cidrs: ["1.2.3.0/24"],
          allowed_cidrs_v6: ["2001:db8::/32"],
        },
      },
    };
    const local: ProjectConfig = {
      db: { network_restrictions: { allowed_cidrs: ["10.0.0.0/8"] } },
    };
    const result = legacyEncodeNetworkRestrictionsBody(
      input({
        changes: [change(["db", "network_restrictions", "allowed_cidrs"], ["10.0.0.0/8"])],
        local,
        remote,
      }),
    );
    expect(result.body).toEqual({
      dbAllowedCidrs: ["10.0.0.0/8"],
      dbAllowedCidrsV6: ["2001:db8::/32"],
    });
    expect(result.forced).toEqual([]);
  });

  it("discloses a forced fallback to local's allowed_cidrs_v6 when remote reports nothing for it", () => {
    const local: ProjectConfig = {
      db: { network_restrictions: { allowed_cidrs: ["10.0.0.0/8"], allowed_cidrs_v6: ["::/0"] } },
    };
    const remote: ProjectConfig = { db: { network_restrictions: {} } };
    const result = legacyEncodeNetworkRestrictionsBody(
      input({
        changes: [change(["db", "network_restrictions", "allowed_cidrs"], ["10.0.0.0/8"])],
        local,
        remote,
      }),
    );
    expect(result.body).toEqual({ dbAllowedCidrs: ["10.0.0.0/8"], dbAllowedCidrsV6: ["::/0"] });
    expect(result.forced).toEqual([
      { path: ["db", "network_restrictions", "allowed_cidrs_v6"], value: ["::/0"] },
    ]);
  });

  it("is up to date when nothing changed", () => {
    const result = legacyEncodeNetworkRestrictionsBody(input());
    expect(result.body).toBeUndefined();
  });

  it("routes both CIDR paths to unencodable (REASON_GROUP_INCOMPLETE), not an empty array, when a companion cannot be resolved from remote or local", () => {
    // Remote and local both lack `allowed_cidrs_v6` entirely — the whole
    // group is incomplete, so nothing should be substituted with `[]`.
    const local: ProjectConfig = {
      db: { network_restrictions: { allowed_cidrs: ["10.0.0.0/8"] } },
    };
    const remote: ProjectConfig = { db: { network_restrictions: {} } };
    const result = legacyEncodeNetworkRestrictionsBody(
      input({
        changes: [change(["db", "network_restrictions", "allowed_cidrs"], ["10.0.0.0/8"])],
        local,
        remote,
      }),
    );
    expect(result.body).toBeUndefined();
    expect(result.unencodable).toEqual([
      {
        path: ["db", "network_restrictions", "allowed_cidrs"],
        reason: "one or more of this group's required fields could not be resolved",
      },
    ]);
    expect(result.forced).toEqual([]);
  });
});

describe("legacyEncodeSslEnforcementBody", () => {
  it("wraps the boolean in requestedConfig.database", () => {
    const result = legacyEncodeSslEnforcementBody(
      input({ changes: [change(["db", "ssl_enforcement", "enabled"], true)] }),
    );
    expect(result.body).toEqual({ requestedConfig: { database: true } });
    expect(result.encoded).toEqual([["db", "ssl_enforcement", "enabled"]]);
  });

  it("is up to date when nothing changed", () => {
    const result = legacyEncodeSslEnforcementBody(input());
    expect(result.body).toBeUndefined();
  });
});

describe("legacyEncodeStorageBody", () => {
  it("ships file_size_limit alone with features absent (sparseness proof)", () => {
    const result = legacyEncodeStorageBody(
      storageInput({ changes: [change(["storage", "file_size_limit"], "100MiB")] }),
    );
    expect(result.body).toEqual({ fileSizeLimit: 104_857_600 });
    expect(Object.keys(result.body ?? {})).toEqual(["fileSizeLimit"]);
    expect(result.encoded).toEqual([["storage", "file_size_limit"]]);
  });

  it("wraps image_transformation/s3_protocol as single-key containers, with fileSizeLimit absent", () => {
    const result = legacyEncodeStorageBody(
      storageInput({
        changes: [
          change(["storage", "image_transformation", "enabled"], true),
          change(["storage", "s3_protocol", "enabled"], false),
        ],
      }),
    );
    expect(result.body).toEqual({
      features: { imageTransformation: { enabled: true }, s3Protocol: { enabled: false } },
    });
    expect(Object.keys(result.body ?? {})).toEqual(["features"]);
    expect(Object.keys(result.body?.features ?? {}).sort()).toEqual([
      "imageTransformation",
      "s3Protocol",
    ]);
  });

  it("ships the whole analytics (iceberg) container when any of its keys changed", () => {
    const local: ProjectConfig = {
      storage: { analytics: { enabled: true, max_namespaces: 5, max_tables: 10, max_catalogs: 2 } },
    };
    const result = legacyEncodeStorageBody(
      storageInput({ changes: [change(["storage", "analytics", "max_tables"], 10)], local }),
    );
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
    const result = legacyEncodeStorageBody(
      storageInput({ changes: [change(["storage", "vector", "enabled"], true)], local }),
    );
    expect(result.body?.features?.vectorBuckets).toEqual({
      enabled: true,
      maxBuckets: 10,
      maxIndexes: 5,
    });
  });

  it("keeps the remote's vector.max_indexes when only enabled changed", () => {
    const local: ProjectConfig = { storage: { vector: { enabled: true } } };
    const remote: ProjectConfig = {
      storage: { vector: { enabled: false, max_buckets: 7, max_indexes: 99 } },
    };
    const result = legacyEncodeStorageBody(
      storageInput({ changes: [change(["storage", "vector", "enabled"], true)], local, remote }),
    );
    expect(result.body?.features?.vectorBuckets).toEqual({
      enabled: true,
      maxBuckets: 7,
      maxIndexes: 99,
    });
    expect(result.forced).toEqual([]);
  });

  it("emits {enabled:false, ...} for analytics, falling back to `config` for max_* the projection pruned, and discloses it as forced", () => {
    const base = getDefaultCliConfig();
    const config: CliConfig = {
      ...base,
      storage: {
        ...base.storage,
        analytics: {
          enabled: false,
          max_namespaces: 7,
          max_tables: 3,
          max_catalogs: 1,
          buckets: {},
        },
      },
    };
    // The real pipeline drops a disabled `storage.analytics` from the local
    // projection entirely (`applyPushUnmanagedOmissions`) — this directly
    // exercises the encoder with that pruned shape, as a change constructed
    // by hand rather than through the full diff pipeline (CLI-2314 note).
    const result = legacyEncodeStorageBody(
      storageInput({ changes: [change(["storage", "analytics", "enabled"], false)], config }),
    );
    expect(result.body?.features?.icebergCatalog).toEqual({
      enabled: false,
      maxNamespaces: 7,
      maxTables: 3,
      maxCatalogs: 1,
    });
    expect(result.forced).toEqual([
      { path: ["storage", "analytics", "max_catalogs"], value: 1 },
      { path: ["storage", "analytics", "max_namespaces"], value: 7 },
      { path: ["storage", "analytics", "max_tables"], value: 3 },
    ]);
  });

  it("emits {enabled:false, ...} for vector, falling back to `config` for max_* the projection pruned", () => {
    const base = getDefaultCliConfig();
    const config: CliConfig = {
      ...base,
      storage: {
        ...base.storage,
        vector: { enabled: false, max_buckets: 11, max_indexes: 6, buckets: {} },
      },
    };
    const result = legacyEncodeStorageBody(
      storageInput({ changes: [change(["storage", "vector", "enabled"], false)], config }),
    );
    expect(result.body?.features?.vectorBuckets).toEqual({
      enabled: false,
      maxBuckets: 11,
      maxIndexes: 6,
    });
  });

  it("is up to date when nothing changed", () => {
    const result = legacyEncodeStorageBody(storageInput());
    expect(result.body).toBeUndefined();
  });
});

describe("legacyEncodeAuthBody", () => {
  it("is up to date (body undefined) when nothing routed to it changed and no secret sends", () => {
    const result = legacyEncodeAuthBody(authInput());
    expect(result.body).toBeUndefined();
    expect(result.encoded).toEqual([]);
    expect(result.extras).toEqual([]);
    expect(result.forced).toEqual([]);
  });

  it("joins additional_redirect_urls with a comma, alone", () => {
    const result = legacyEncodeAuthBody(
      authInput({ changes: [change(["auth", "additional_redirect_urls"], ["a", "b"])] }),
    );
    expect(result.body).toEqual({ uri_allow_list: "a,b" });
    expect(Object.keys(result.body ?? {})).toEqual(["uri_allow_list"]);
  });

  it("inverts enable_signup into disable_signup", () => {
    const result = legacyEncodeAuthBody(
      authInput({ changes: [change(["auth", "enable_signup"], true)] }),
    );
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

  describe("invalid durations route to unencodable, never a silent 0", () => {
    const REASON = "the declared value is not a valid duration";

    it("sessions.timebox: an unparseable string", () => {
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "sessions", "timebox"], "not-a-duration")] }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        { path: ["auth", "sessions", "timebox"], reason: REASON },
      ]);
    });

    it("mfa.phone.max_frequency: a non-string value", () => {
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "mfa", "phone", "max_frequency"], 42)] }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        { path: ["auth", "mfa", "phone", "max_frequency"], reason: REASON },
      ]);
    });

    it("smtp_max_frequency (email.max_frequency): an unparseable string", () => {
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "email", "max_frequency"], "5 minutes")] }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        { path: ["auth", "email", "max_frequency"], reason: REASON },
      ]);
    });

    it("sms_max_frequency (sms.max_frequency): a non-string value", () => {
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "sms", "max_frequency"], null)] }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        { path: ["auth", "sms", "max_frequency"], reason: REASON },
      ]);
    });
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
        authInput({
          changes: [change(["auth", "email", "smtp", "host"], "smtp.example.com")],
          local,
        }),
      );
      expect(result.body).toEqual({
        smtp_host: "smtp.example.com",
        smtp_port: "587",
        smtp_user: "user",
        smtp_admin_email: "a@b.com",
        smtp_sender_name: "Sender",
      });
    });

    it("prefers the remote's current companion values over local schema defaults", () => {
      const local: ProjectConfig = {
        auth: {
          email: {
            smtp: {
              enabled: true,
              host: "smtp.example.com",
              port: 0,
              user: "",
              admin_email: "",
              sender_name: "",
            },
          },
        },
      };
      const remote: ProjectConfig = {
        auth: {
          email: {
            smtp: {
              enabled: true,
              host: "smtp.example.com",
              port: 2525,
              user: "remote-user",
              admin_email: "remote@example.com",
              sender_name: "Remote Sender",
            },
          },
        },
      };
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "email", "smtp", "host"], "smtp.example.com")],
          local,
          remote,
        }),
      );
      expect(result.body).toEqual({
        smtp_host: "smtp.example.com",
        smtp_port: "2525",
        smtp_user: "remote-user",
        smtp_admin_email: "remote@example.com",
        smtp_sender_name: "Remote Sender",
      });
      expect(result.forced).toEqual([]);
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
        secretDecision({
          path: ["auth", "email", "smtp", "pass"],
          apiKey: "smtp_pass",
          status: "send",
          plaintext: "hunter2",
        }),
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
      expect(result.secretsEncoded).toEqual([["auth", "email", "smtp", "pass"]]);
    });

    it("withholds smtp_pass while unchanged/gated/not_set", () => {
      const local: ProjectConfig = {
        auth: {
          email: {
            smtp: {
              enabled: true,
              host: "h",
              port: 1,
              user: "user",
              admin_email: "a@b.com",
              sender_name: "Sender",
            },
          },
        },
      };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        secretDecision({
          path: ["auth", "email", "smtp", "pass"],
          apiKey: "smtp_pass",
          status: "unchanged",
        }),
      ];
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "email", "smtp", "host"], "h")], local, secrets }),
      );
      expect(result.body).not.toHaveProperty("smtp_pass");
    });

    it("routes the container's changes to unencodable when its enabled state cannot be determined", () => {
      const local: ProjectConfig = { auth: { email: { smtp: {} } } };
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "email", "smtp", "host"], "h")], local }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        {
          path: ["auth", "email", "smtp", "host"],
          reason: "the container's enabled state could not be determined from the declared config",
        },
      ]);
    });

    it("routes the whole container to unencodable (REASON_GROUP_INCOMPLETE) when a companion cannot be resolved from remote or local", () => {
      const local: ProjectConfig = { auth: { email: { smtp: { enabled: true, host: "h" } } } };
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "email", "smtp", "host"], "h")], local }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        {
          path: ["auth", "email", "smtp", "host"],
          reason: "one or more of this group's required fields could not be resolved",
        },
      ]);
    });

    it("a secret-only trigger whose group is incomplete is reported unencodable, not silently dropped", () => {
      // No ordinary change at all — only the `pass` secret is `send` — and the
      // group's other companions cannot be resolved from remote or local.
      const local: ProjectConfig = { auth: { email: { smtp: { enabled: true } } } };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        secretDecision({
          path: ["auth", "email", "smtp", "pass"],
          apiKey: "smtp_pass",
          status: "send",
          plaintext: "hunter2",
        }),
      ];
      const result = legacyEncodeAuthBody(authInput({ local, secrets }));
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        {
          path: ["auth", "email", "smtp", "pass"],
          reason: "one or more of this group's required fields could not be resolved",
        },
      ]);
      expect(result.secretsEncoded).toEqual([]);
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
        secretDecision({
          path: ["auth", "captcha", "secret"],
          apiKey: "security_captcha_secret",
          status: "send",
          plaintext: "shh",
        }),
      ];
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "captcha", "provider"], "hcaptcha")],
          local,
          secrets,
        }),
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
        secretDecision({
          path: ["auth", "hook", "send_email", "secrets"],
          apiKey: "hook_send_email_secrets",
          status: "send",
          plaintext: "v1,whsec_abc",
        }),
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

    it("routes the hook to unencodable (REASON_GROUP_INCOMPLETE) when uri cannot be resolved", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "hook", "send_email", "enabled"], true)],
          local: { auth: { hook: { send_email: { enabled: true } } } },
        }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        {
          path: ["auth", "hook", "send_email", "enabled"],
          reason: "one or more of this group's required fields could not be resolved",
        },
      ]);
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
        secretDecision({
          path: ["auth", "external", "github", "secret"],
          apiKey: "external_github_secret",
          status: "send",
          plaintext: "gh-secret",
        }),
      ];
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "external", "github", "client_id"], "id")],
          local,
          secrets,
        }),
      );
      expect(result.body).toEqual({
        external_github_enabled: true,
        external_github_client_id: "id",
        external_github_secret: "gh-secret",
        external_github_email_optional: true,
      });
    });

    it("keeps the remote's email_optional when it is undeclared locally", () => {
      const local: ProjectConfig = { auth: { external: { github: { enabled: true } } } };
      const remote: ProjectConfig = {
        auth: { external: { github: { enabled: true, client_id: "id", email_optional: true } } },
      };
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "external", "github", "client_id"], "id")],
          local,
          remote,
        }),
      );
      expect(result.body).toMatchObject({ external_github_email_optional: true });
      expect(result.forced).toEqual([]);
    });

    it("never emits email_optional for workos (no such API field)", () => {
      const local: ProjectConfig = {
        auth: {
          external: {
            workos: { enabled: true, client_id: "id", url: "https://workos.example.com" },
          },
        },
      };
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "external", "workos", "client_id"], "id")], local }),
      );
      expect(result.body).not.toHaveProperty("external_workos_email_optional");
      expect(result.body).toMatchObject({ external_workos_url: "https://workos.example.com" });
    });

    it("ships url only for azure/gitlab/keycloak/workos", () => {
      const local: ProjectConfig = {
        auth: {
          external: {
            azure: {
              enabled: true,
              client_id: "id",
              url: "https://azure.example.com",
              email_optional: false,
            },
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
            google: {
              enabled: true,
              client_id: "id",
              email_optional: false,
              skip_nonce_check: true,
            },
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
        authInput({
          changes: [change(["auth", "external", "apple", "client_id"], "id-1,id-2")],
          local,
        }),
      );
      expect(result.body).toMatchObject({ external_apple_client_id: "id-1,id-2" });
      expect(result.body).not.toHaveProperty("external_apple_additional_client_ids");
    });

    it("triggers purely from a secret 'send' decision with no ordinary field change", () => {
      const local: ProjectConfig = {
        auth: { external: { github: { enabled: true, client_id: "id", email_optional: false } } },
      };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        secretDecision({
          path: ["auth", "external", "github", "secret"],
          apiKey: "external_github_secret",
          status: "send",
          plaintext: "gh-secret",
        }),
      ];
      const result = legacyEncodeAuthBody(authInput({ local, secrets }));
      expect(result.body).toEqual({
        external_github_enabled: true,
        external_github_client_id: "id",
        external_github_secret: "gh-secret",
        external_github_email_optional: false,
      });
      expect(result.encoded).toEqual([]);
      expect(result.secretsEncoded).toEqual([["auth", "external", "github", "secret"]]);
    });

    it("routes the provider to unencodable (REASON_GROUP_INCOMPLETE) when client_id cannot be resolved", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "external", "github", "enabled"], true)],
          local: { auth: { external: { github: { enabled: true } } } },
        }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        {
          path: ["auth", "external", "github", "enabled"],
          reason: "one or more of this group's required fields could not be resolved",
        },
      ]);
    });

    it("a secret-only trigger whose client_id cannot be resolved is reported unencodable, not silently dropped", () => {
      const local: ProjectConfig = { auth: { external: { github: { enabled: true } } } };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        secretDecision({
          path: ["auth", "external", "github", "secret"],
          apiKey: "external_github_secret",
          status: "send",
          plaintext: "gh-secret",
        }),
      ];
      const result = legacyEncodeAuthBody(authInput({ local, secrets }));
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        {
          path: ["auth", "external", "github", "secret"],
          reason: "one or more of this group's required fields could not be resolved",
        },
      ]);
      expect(result.secretsEncoded).toEqual([]);
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
      // Bare-digit phone keys — the API's `sms_test_otp` pattern
      // (`^(?:[0-9]{1,15}=...)?$`) rejects a leading `+`.
      const local: ProjectConfig = {
        auth: { sms: { test_otp: { "15555550100": "123456", "15555550101": "654321" } } },
      };
      const result = legacyEncodeAuthBody(
        authInput({
          changes: [change(["auth", "sms", "test_otp", "15555550100"], "123456")],
          local,
          now: new Date("2030-06-15T12:00:00.000Z"),
        }),
      );
      expect(result.body).toEqual({
        sms_test_otp: "15555550100=123456,15555550101=654321",
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
        secretDecision({
          path: ["auth", "sms", "twilio", "auth_token"],
          apiKey: "sms_twilio_auth_token",
          status: "send",
          plaintext: "token",
        }),
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
      expect(result.secretsEncoded).toEqual([["auth", "sms", "twilio", "auth_token"]]);
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

    it("no provider enabled is unencodable, with the D5 reason", () => {
      const local: ProjectConfig = { auth: { sms: { twilio: { enabled: false } } } };
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "sms", "twilio", "enabled"], false)], local }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        {
          path: ["auth", "sms", "twilio", "enabled"],
          reason:
            "config push can switch between SMS providers but cannot turn the active provider off; disable phone sign-in or use the dashboard",
        },
      ]);
    });

    it("routes the active provider to unencodable (REASON_GROUP_INCOMPLETE) when a credential field cannot be resolved", () => {
      const local: ProjectConfig = { auth: { sms: { twilio: { enabled: true } } } };
      const result = legacyEncodeAuthBody(
        authInput({ changes: [change(["auth", "sms", "twilio", "enabled"], true)], local }),
      );
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        {
          path: ["auth", "sms", "twilio", "enabled"],
          reason: "one or more of this group's required fields could not be resolved",
        },
      ]);
    });

    it("a secret-only trigger with no active provider is reported unencodable, not silently dropped", () => {
      const local: ProjectConfig = { auth: { sms: { twilio: { enabled: false } } } };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        secretDecision({
          path: ["auth", "sms", "twilio", "auth_token"],
          apiKey: "sms_twilio_auth_token",
          status: "send",
          plaintext: "token",
        }),
      ];
      const result = legacyEncodeAuthBody(authInput({ local, secrets }));
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        {
          path: ["auth", "sms", "twilio", "auth_token"],
          reason:
            "config push can switch between SMS providers but cannot turn the active provider off; disable phone sign-in or use the dashboard",
        },
      ]);
    });

    it("a secret-only trigger whose active provider's group is incomplete is reported unencodable", () => {
      const local: ProjectConfig = { auth: { sms: { twilio: { enabled: true } } } };
      const secrets: ReadonlyArray<LegacyPushSecretDecision> = [
        secretDecision({
          path: ["auth", "sms", "twilio", "auth_token"],
          apiKey: "sms_twilio_auth_token",
          status: "send",
          plaintext: "token",
        }),
      ];
      const result = legacyEncodeAuthBody(authInput({ local, secrets }));
      expect(result.body).toBeUndefined();
      expect(result.unencodable).toEqual([
        {
          path: ["auth", "sms", "twilio", "auth_token"],
          reason: "one or more of this group's required fields could not be resolved",
        },
      ]);
      expect(result.secretsEncoded).toEqual([]);
    });
  });

  describe("push-only mailer content", () => {
    it("ships template content that differs from the remote key, as an extra rather than an encoded change", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          emailContent: { template: { invite: "<h1>Invite</h1>" }, notification: {} },
          remoteAuthAttributes: { mailer_templates_invite_content: "<p>old</p>" },
        }),
      );
      expect(result.body).toEqual({ mailer_templates_invite_content: "<h1>Invite</h1>" });
      expect(result.encoded).toEqual([]);
      expect(result.extras).toEqual([
        { path: ["auth", "email", "template", "invite", "content"], label: "content" },
      ]);
    });

    it("omits template content that already matches the remote key", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          emailContent: { template: { invite: "<h1>Invite</h1>" }, notification: {} },
          remoteAuthAttributes: { mailer_templates_invite_content: "<h1>Invite</h1>" },
        }),
      );
      expect(result.body).toBeUndefined();
      expect(result.extras).toEqual([]);
    });

    it("ships notification content only when loaded (enabled), as an extra", () => {
      const result = legacyEncodeAuthBody(
        authInput({
          emailContent: { template: {}, notification: { password_changed: "<p>Changed</p>" } },
          remoteAuthAttributes: {},
        }),
      );
      expect(result.body).toEqual({
        mailer_templates_password_changed_notification_content: "<p>Changed</p>",
      });
      expect(result.encoded).toEqual([]);
      expect(result.extras).toEqual([
        {
          path: ["auth", "email", "notification", "password_changed", "content"],
          label: "content",
        },
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

describe("auth encoder key-name drift guard", () => {
  /**
   * Every `(configPath, apiKey)` pair the auth encoder maps, across the flat
   * leaf table AND every string-built container (smtp, captcha, hooks,
   * external providers, sms-provider credentials, email template
   * subjects, email notification enabled+subject). For each pair, asserts
   * the apiKey matches the registry's OWN `apiPath` for that configPath
   * (`@supabase/config/internal`'s `projectConfigMappingRows`) — a guard
   * against `push.encoders.ts` silently drifting from the registry `config
   * pull`/`config diff` also read.
   *
   * The leaf table (`LEGACY_PUSH_AUTH_LEAF_MAP`) is imported, not
   * re-declared, so this guard tests the actual source of truth the encoder
   * iterates — a change to that table is exercised here automatically. The
   * container groups build their `apiKey` from a string template instead
   * (`smtp_${field}`, `hook_${name}_enabled`, `external_${id}_client_id`,
   * `sms_${provider}_${key}`, `mailer_subjects_${name}`, …), so their pairs
   * are enumerated directly against the registry below.
   */
  interface LeafPair {
    readonly configPath: ReadonlyArray<string>;
    readonly apiKey: string;
  }

  const leafPairs: ReadonlyArray<LeafPair> = LEGACY_PUSH_AUTH_LEAF_MAP.map((spec) => ({
    configPath: spec.configPath,
    apiKey: spec.apiKey,
  }));

  const smtpPairs: ReadonlyArray<LeafPair> = [
    { configPath: ["auth", "email", "smtp", "host"], apiKey: "smtp_host" },
    { configPath: ["auth", "email", "smtp", "port"], apiKey: "smtp_port" },
    { configPath: ["auth", "email", "smtp", "user"], apiKey: "smtp_user" },
    { configPath: ["auth", "email", "smtp", "admin_email"], apiKey: "smtp_admin_email" },
    { configPath: ["auth", "email", "smtp", "sender_name"], apiKey: "smtp_sender_name" },
    { configPath: ["auth", "email", "smtp", "pass"], apiKey: "smtp_pass" },
  ];

  const captchaPairs: ReadonlyArray<LeafPair> = [
    { configPath: ["auth", "captcha", "enabled"], apiKey: "security_captcha_enabled" },
    { configPath: ["auth", "captcha", "provider"], apiKey: "security_captcha_provider" },
    { configPath: ["auth", "captcha", "secret"], apiKey: "security_captcha_secret" },
  ];

  const hookPairs: ReadonlyArray<LeafPair> = AUTH_HOOK_NAMES.flatMap((name) => [
    { configPath: ["auth", "hook", name, "enabled"], apiKey: `hook_${name}_enabled` },
    { configPath: ["auth", "hook", name, "uri"], apiKey: `hook_${name}_uri` },
    { configPath: ["auth", "hook", name, "secrets"], apiKey: `hook_${name}_secrets` },
  ]);

  const providerPairs: ReadonlyArray<LeafPair> = [
    ...LEGACY_EXTERNAL_PROVIDER_IDS.flatMap((id) => [
      { configPath: ["auth", "external", id, "enabled"], apiKey: `external_${id}_enabled` },
      { configPath: ["auth", "external", id, "client_id"], apiKey: `external_${id}_client_id` },
      { configPath: ["auth", "external", id, "secret"], apiKey: `external_${id}_secret` },
    ]),
    ...LEGACY_PROVIDERS_WITH_URL.map((id) => ({
      configPath: ["auth", "external", id, "url"],
      apiKey: `external_${id}_url`,
    })),
    ...LEGACY_PROVIDERS_WITH_EMAIL_OPTIONAL.map((id) => ({
      configPath: ["auth", "external", id, "email_optional"],
      apiKey: `external_${id}_email_optional`,
    })),
    ...LEGACY_PROVIDERS_WITH_SKIP_NONCE_CHECK.map((id) => ({
      configPath: ["auth", "external", id, "skip_nonce_check"],
      apiKey: `external_${id}_skip_nonce_check`,
    })),
  ];

  const smsProviderCredentialPairs: ReadonlyArray<LeafPair> = [
    { configPath: ["auth", "sms", "twilio", "account_sid"], apiKey: "sms_twilio_account_sid" },
    {
      configPath: ["auth", "sms", "twilio", "message_service_sid"],
      apiKey: "sms_twilio_message_service_sid",
    },
    { configPath: ["auth", "sms", "twilio", "auth_token"], apiKey: "sms_twilio_auth_token" },
    {
      configPath: ["auth", "sms", "twilio_verify", "account_sid"],
      apiKey: "sms_twilio_verify_account_sid",
    },
    {
      configPath: ["auth", "sms", "twilio_verify", "message_service_sid"],
      apiKey: "sms_twilio_verify_message_service_sid",
    },
    {
      configPath: ["auth", "sms", "twilio_verify", "auth_token"],
      apiKey: "sms_twilio_verify_auth_token",
    },
    {
      configPath: ["auth", "sms", "messagebird", "originator"],
      apiKey: "sms_messagebird_originator",
    },
    {
      configPath: ["auth", "sms", "messagebird", "access_key"],
      apiKey: "sms_messagebird_access_key",
    },
    { configPath: ["auth", "sms", "textlocal", "sender"], apiKey: "sms_textlocal_sender" },
    { configPath: ["auth", "sms", "textlocal", "api_key"], apiKey: "sms_textlocal_api_key" },
    { configPath: ["auth", "sms", "vonage", "api_key"], apiKey: "sms_vonage_api_key" },
    { configPath: ["auth", "sms", "vonage", "from"], apiKey: "sms_vonage_from" },
    { configPath: ["auth", "sms", "vonage", "api_secret"], apiKey: "sms_vonage_api_secret" },
  ];

  const templateSubjectPairs: ReadonlyArray<LeafPair> = LEGACY_EMAIL_TEMPLATE_NAMES.map((name) => ({
    configPath: ["auth", "email", "template", name, "subject"],
    apiKey: `mailer_subjects_${name}`,
  }));

  const notificationPairs: ReadonlyArray<LeafPair> = LEGACY_EMAIL_NOTIFICATION_NAMES.flatMap(
    (name) => [
      {
        configPath: ["auth", "email", "notification", name, "enabled"],
        apiKey: `mailer_notifications_${name}_enabled`,
      },
      {
        configPath: ["auth", "email", "notification", name, "subject"],
        apiKey: `mailer_subjects_${name}_notification`,
      },
    ],
  );

  const allPairs: ReadonlyArray<LeafPair> = [
    ...leafPairs,
    ...smtpPairs,
    ...captchaPairs,
    ...hookPairs,
    ...providerPairs,
    ...smsProviderCredentialPairs,
    ...templateSubjectPairs,
    ...notificationPairs,
  ];

  it("covers exactly 182 (configPath, apiKey) pairs (42 leaf + 6 smtp + 3 captcha + 18 hooks + 80 providers + 13 sms credentials + 6 template subjects + 14 notifications)", () => {
    expect(leafPairs.length).toBe(42);
    expect(allPairs.length).toBe(182);
  });

  it.each(allPairs.map((pair) => [pair.configPath.join("."), pair] as const))(
    "%s's apiKey matches the registry's own apiPath",
    (_label, pair) => {
      const row = projectConfigMappingRows.find((candidate) =>
        legacySamePath(candidate.configPath, pair.configPath),
      );
      expect(row?.apiPath.at(-1)).toBe(pair.apiKey);
    },
  );
});
