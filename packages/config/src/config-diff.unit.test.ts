import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { CliConfigSchema } from "./base.ts";
import { diffProjectConfig, isEqualConfigValue, type ConfigChange } from "./config-diff.ts";
import type { CliConfigValueOrigin } from "./config-document.ts";
import {
  comparableProjectConfigPaths,
  fromApiProjectConfig,
  fromConfigDocument,
} from "./project-config/project-config.ts";
import { projectConfigMappingRows } from "./project-config/registry.ts";
import { getDefaultCliConfig } from "./sparse.ts";

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

/**
 * Builds the diff input the way the command layer does: the local operand is the loaded
 * `{config, document}` pair (so raw-presence masking applies), the remote operand is
 * `fromApiProjectConfig` over bare v2 `data.attributes`.
 */
function diffWith(
  declared: Record<string, unknown>,
  attributes: Record<string, unknown>,
  valueOrigins?: ReadonlyArray<CliConfigValueOrigin>,
) {
  return diffProjectConfig({
    local: { config: decodeCliConfig(declared), document: declared, valueOrigins },
    remote: fromApiProjectConfig(attributes),
  });
}

function changeAt(
  changes: ReadonlyArray<ConfigChange>,
  path: ReadonlyArray<string>,
): ConfigChange | undefined {
  return changes.find(
    (change) =>
      change.path.length === path.length &&
      change.path.every((segment, index) => segment === path[index]),
  );
}

describe("diffProjectConfig classification", () => {
  test("an undefined declared document means nothing is declared", () => {
    const result = diffProjectConfig({
      local: { config: decodeCliConfig({}) },
      remote: fromApiProjectConfig({ api: { max_rows: 250 } }),
    });
    expect(changeAt(result.changes, ["api", "max_rows"])).toMatchObject({ class: "remote_only" });
  });

  test("declared value differing from remote is an update", () => {
    const result = diffWith({ api: { max_rows: 500 } }, { api: { max_rows: 1000 } });
    const change = changeAt(result.changes, ["api", "max_rows"]);
    expect(change).toMatchObject({ class: "update", local: 500, remote: 1000, declared: true });
    expect(result.counts.update).toBe(1);
  });

  test("declared value equal to remote is not a difference", () => {
    const result = diffWith({ api: { max_rows: 500 } }, { api: { max_rows: 500 } });
    expect(result.changes).toEqual([]);
    expect(result.counts).toEqual({ update: 0, remote_only: 0, local_only: 0, total: 0 });
  });

  test("remote value at the schema default is suppressed when undeclared", () => {
    const result = diffWith({}, { api: { max_rows: 1000 } });
    expect(changeAt(result.changes, ["api", "max_rows"])).toBeUndefined();
  });

  test("remote-only drift keeps the materialized local default and declared: false", () => {
    // The file is silent, so the local projection carries the schema default; a push would
    // overwrite the remote value with it, so the change must say so.
    const result = diffWith({}, { api: { max_rows: 250 } });
    const change = changeAt(result.changes, ["api", "max_rows"]);
    expect(change).toMatchObject({
      class: "remote_only",
      local: 1000,
      remote: 250,
      declared: false,
    });
  });

  test("raw-presence-masked sections suppress zero-valued remotes", () => {
    // db.ssl_enforcement is raw-presence-masked (ADR 0021): its local projection stays silent
    // when the file never declares it, so the platform's unconfigured state is not drift.
    const clean = diffWith({}, { database: { ssl_enforced: false } });
    expect(changeAt(clean.changes, ["db", "ssl_enforcement", "enabled"])).toBeUndefined();

    const drifted = diffWith({}, { database: { ssl_enforced: true } });
    expect(changeAt(drifted.changes, ["db", "ssl_enforcement", "enabled"])).toMatchObject({
      class: "remote_only",
      remote: true,
    });
  });

  test("push-gated containers fall back to the raw schema default as baseline", () => {
    // Push gates network-restriction CIDRs on the local `enabled` toggle, so the default
    // projection is silent on them; the raw schema default (allow-all) is the platform's
    // unconfigured state, so reporting it would flag every untouched project.
    const clean = diffWith(
      {},
      {
        database: {
          network_restrictions: {
            allowed_cidrs: [
              { address: "0.0.0.0/0", type: "v4" },
              { address: "::/0", type: "v6" },
            ],
          },
        },
      },
    );
    expect(clean.changes).toEqual([]);

    const drifted = diffWith(
      {},
      {
        database: {
          network_restrictions: { allowed_cidrs: [{ address: "10.0.0.0/8", type: "v4" }] },
        },
      },
    );
    expect(
      changeAt(drifted.changes, ["db", "network_restrictions", "allowed_cidrs"]),
    ).toMatchObject({
      class: "remote_only",
      remote: ["10.0.0.0/8"],
    });
  });

  test("canonicalized zero durations suppress via the row's unconfiguredValue", () => {
    // GoTrue reports 0 hours for unconfigured session bounds; the transform canonicalizes that
    // to the string "0s", which the registry row's `unconfiguredValue` recognizes as clean.
    const clean = diffWith({}, { auth: { sessions_timebox: 0, sessions_inactivity_timeout: 0 } });
    expect(clean.changes).toEqual([]);

    const drifted = diffWith({}, { auth: { sessions_timebox: 24 } });
    expect(changeAt(drifted.changes, ["auth", "sessions", "timebox"])).toMatchObject({
      class: "remote_only",
      remote: "24h0m0s",
    });
  });

  test("platform-rendered mailer subjects suppress regardless of the remote string", () => {
    // Subject lines are rendered by the platform, so there's no fixed baseline string to pin;
    // `platformRendered` suppresses any remote string while the file stays silent.
    const clean = diffWith(
      {},
      {
        auth: {
          mailer_subjects_confirmation: "Confirm your email address",
          mailer_subjects_password_changed_notification: "Your password was changed",
          mailer_notifications_password_changed_enabled: false,
        },
      },
    );
    expect(clean.changes).toEqual([]);

    const drifted = diffWith(
      {},
      {
        auth: {
          mailer_subjects_confirmation: "Whatever the platform renders today",
          mailer_notifications_password_changed_enabled: true,
        },
      },
    );
    expect(
      changeAt(drifted.changes, ["auth", "email", "template", "confirmation", "subject"]),
    ).toBeUndefined();
    expect(
      changeAt(drifted.changes, ["auth", "email", "notification", "password_changed", "enabled"]),
    ).toMatchObject({ class: "remote_only", remote: true });
  });

  test("a declared mailer subject still classifies normally against the remote", () => {
    // `platformRendered` only suppresses while the local projection is silent — a locally
    // declared subject compares like any other field.
    const differs = diffWith(
      { auth: { email: { template: { confirmation: { subject: "Welcome to ACME" } } } } },
      { auth: { mailer_subjects_confirmation: "Confirm your email address" } },
    );
    expect(
      changeAt(differs.changes, ["auth", "email", "template", "confirmation", "subject"]),
    ).toMatchObject({
      class: "update",
      local: "Welcome to ACME",
      remote: "Confirm your email address",
      declared: true,
    });

    const missing = diffWith(
      { auth: { email: { template: { confirmation: { subject: "Welcome to ACME" } } } } },
      { auth: {} },
    );
    expect(
      changeAt(missing.changes, ["auth", "email", "template", "confirmation", "subject"]),
    ).toMatchObject({ class: "local_only", local: "Welcome to ACME" });
  });

  test("every comparable path without a config-side baseline makes a deliberate choice", () => {
    // Registry-driven guard: for each comparable path the default config is silent on, its row
    // must declare either `unconfiguredValue` (a matching remote report classifies clean),
    // `platformRendered` (any remote report classifies clean), or rely on structural absence —
    // in which case a zero-form remote value must still report as drift, not be silently
    // swallowed.
    const defaults = fromConfigDocument(getDefaultCliConfig());
    const raw = getDefaultCliConfig();
    const valueAt = (root: unknown, path: ReadonlyArray<string>): unknown => {
      let current: unknown = root;
      for (const segment of path) {
        if (
          typeof current !== "object" ||
          current === null ||
          Array.isArray(current) ||
          !Object.hasOwn(current, segment)
        ) {
          return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
      }
      return current;
    };
    const rowFor = (path: ReadonlyArray<string>) =>
      projectConfigMappingRows.find(
        (row) =>
          row.configPath.length === path.length &&
          row.configPath.every((segment, index) => segment === path[index]),
      );

    const baselineless = comparableProjectConfigPaths.filter(
      (path) => (valueAt(defaults, path) ?? valueAt(raw, path)) === undefined,
    );
    expect(baselineless.length).toBeGreaterThan(0);

    for (const path of baselineless) {
      const row = rowFor(path);
      expect(row, path.join(".")).toBeDefined();
      if (row !== undefined && row.unconfiguredValue !== undefined) {
        // The declared unconfigured value classifies clean.
        const projected: Record<string, unknown> = {};
        let cursor = projected;
        for (const segment of path.slice(0, -1)) {
          cursor[segment] = {};
          cursor = cursor[segment] as Record<string, unknown>;
        }
        cursor[path[path.length - 1] as string] = row.unconfiguredValue;
        const result = diffProjectConfig({
          local: { config: decodeCliConfig({}), document: {} },
          remote: projected,
        });
        expect(changeAt(result.changes, path), path.join(".")).toBeUndefined();
      } else if (row !== undefined && row.platformRendered === true) {
        // A platform-rendered row classifies clean for any remote value, verified with an
        // arbitrary string rather than the one the platform happens to send today.
        const projected: Record<string, unknown> = {};
        let cursor = projected;
        for (const segment of path.slice(0, -1)) {
          cursor[segment] = {};
          cursor = cursor[segment] as Record<string, unknown>;
        }
        cursor[path[path.length - 1] as string] = "an arbitrary platform-rendered value";
        const result = diffProjectConfig({
          local: { config: decodeCliConfig({}), document: {} },
          remote: projected,
        });
        expect(changeAt(result.changes, path), path.join(".")).toBeUndefined();
      } else {
        // A path relying on structural absence must still report a zero-form remote value:
        // inject one directly into the projection, bypassing the normalizer that omits it today.
        const projected: Record<string, unknown> = {};
        let cursor = projected;
        for (const segment of path.slice(0, -1)) {
          cursor[segment] = {};
          cursor = cursor[segment] as Record<string, unknown>;
        }
        cursor[path[path.length - 1] as string] = "";
        const result = diffProjectConfig({
          local: { config: decodeCliConfig({}), document: {} },
          remote: projected,
        });
        expect(changeAt(result.changes, path), path.join(".")).toMatchObject({
          class: "remote_only",
        });
      }
    }
  });

  test("undeclared providers reporting their unconfigured state are not drift", () => {
    const result = diffWith(
      {},
      { auth: { external_github_enabled: false, external_github_client_id: "" } },
    );
    expect(result.changes.filter((change) => change.path.includes("github"))).toEqual([]);
  });

  test("declared value the response does not carry is local_only", () => {
    const result = diffWith(
      { auth: { site_url: "https://local.example.com" } },
      // auth block present but without site_url.
      { auth: {} },
    );
    expect(changeAt(result.changes, ["auth", "site_url"])).toMatchObject({
      class: "local_only",
      local: "https://local.example.com",
      remote: undefined,
      declared: true,
    });
  });

  test("a wholly absent block turns its declared properties local_only", () => {
    const result = diffWith({ db: { settings: { max_connections: 120 } } }, {});
    expect(changeAt(result.changes, ["db", "settings", "max_connections"])).toMatchObject({
      class: "local_only",
      local: 120,
    });
  });

  test("unmanaged declared properties are never reported", () => {
    const result = diffWith(
      {
        studio: { port: 55555 },
        api: { port: 4321 },
        realtime: { max_header_length: 8192 },
        local_smtp: { enabled: true },
      },
      { api: {}, realtime: { max_concurrent_users: 5 } },
    );
    expect(result.changes).toEqual([]);
  });

  test("a declared push-unmanaged sibling surfaces in unmanaged, never as a false clean", () => {
    // A disabled `auth.oauth_server`'s siblings are retained-but-inert platform state that
    // `config push` cannot communicate — pruned from the document projection — so a disagreeing
    // declared value must surface in `unmanaged`, not as a false clean `change`.
    const result = diffWith(
      { auth: { oauth_server: { enabled: false, authorization_url_path: "/consent" } } },
      { auth: { oauth_server_enabled: false, oauth_server_authorization_path: "/other" } },
    );
    expect(result.changes).toEqual([]);
    expect(result.unmanaged).toContainEqual(["auth", "oauth_server", "authorization_url_path"]);
  });

  test("a push-unmanaged sibling is excluded from classification even when the remote AGREES with it", () => {
    // Matching values here proves the exclusion itself, not an accidental match (ADR 0022):
    // unmanaged paths can never classify, even when local and remote agree.
    const result = diffWith(
      { auth: { oauth_server: { enabled: false, authorization_url_path: "/consent" } } },
      { auth: { oauth_server_enabled: false, oauth_server_authorization_path: "/consent" } },
    );
    expect(result.changes).toEqual([]);
    expect(result.unmanaged).toContainEqual(["auth", "oauth_server", "authorization_url_path"]);
    expect(result.counts.total).toBe(0);
  });

  test("push-unmanaged siblings are excluded from classification even when the remote DIFFERS from them", () => {
    // Live repro: config.toml declares storage.analytics disabled with a max_namespaces value,
    // the platform reports it enabled with a different value — `max_namespaces` is pruned from
    // the document projection, so it can only be `unmanaged`, never `remote_only`.
    const result = diffWith(
      { storage: { analytics: { enabled: false, max_namespaces: 5 } } },
      { storage: { features: { iceberg_catalog: { enabled: true, max_namespaces: 10 } } } },
    );
    expect(changeAt(result.changes, ["storage", "analytics", "enabled"])).toMatchObject({
      class: "update",
      local: false,
      remote: true,
    });
    expect(changeAt(result.changes, ["storage", "analytics", "max_namespaces"])).toBeUndefined();
    expect(result.unmanaged).not.toContainEqual(["storage", "analytics", "enabled"]);
    expect(result.unmanaged).toContainEqual(["storage", "analytics", "max_namespaces"]);
  });

  test("declared siblings of a disabled container surface in unmanaged", () => {
    // Push writes only the disable sentinel for a disabled SMTP block, so a declared host is
    // never communicated — the projection prunes it, and `unmanaged` says so.
    const result = diffWith(
      { auth: { email: { smtp: { enabled: false, host: "mail.example.com" } } } },
      { auth: {} },
    );
    expect(result.unmanaged).toContainEqual(["auth", "email", "smtp", "host"]);
  });

  test("an undeclared config is fully managed", () => {
    const result = diffWith({}, { auth: {} });
    expect(result.unmanaged).toEqual([]);
  });

  test("db.major_version and db.pooler.* classify as normal update/remote_only, never unmanaged (PR #6451 correction)", () => {
    // Both are `comparableProjectConfigPaths` members that `fromConfigDocument` populates
    // normally, so they classify as ordinary update/remote_only rather than `unmanaged`.
    const result = diffWith(
      { db: { major_version: 15, pooler: { pool_mode: "session", default_pool_size: 15 } } },
      {
        database: { major_version: 17 },
        pooler: { pool_mode: "transaction", default_pool_size: 20 },
      },
    );
    expect(changeAt(result.changes, ["db", "major_version"])).toMatchObject({
      class: "update",
      local: 15,
      remote: 17,
    });
    expect(changeAt(result.changes, ["db", "pooler", "pool_mode"])).toMatchObject({
      class: "update",
      local: "session",
      remote: "transaction",
    });
    expect(changeAt(result.changes, ["db", "pooler", "default_pool_size"])).toMatchObject({
      class: "update",
      local: 15,
      remote: 20,
    });
    expect(result.unmanaged).toEqual([]);
  });

  test("db.pooler.enabled and db.pooler.port are never comparable — v2GetProjectConfig reports neither", () => {
    // Unlike their siblings above, these two have no registry row at all, so they never reach
    // the comparison loop regardless of local/remote presence.
    const result = diffWith(
      { db: { pooler: { enabled: false, port: 12345 } } },
      { pooler: { pool_mode: "session" } },
    );
    expect(changeAt(result.changes, ["db", "pooler", "enabled"])).toBeUndefined();
    expect(changeAt(result.changes, ["db", "pooler", "port"])).toBeUndefined();
    expect(result.unmanaged).not.toContainEqual(["db", "pooler", "enabled"]);
    expect(result.unmanaged).not.toContainEqual(["db", "pooler", "port"]);
  });

  test("sequence arrays register reordering as drift", () => {
    // api.schemas is order-significant (the first entry is PostgREST's default schema), so a
    // reordering is real drift.
    const result = diffWith(
      { api: { schemas: ["public", "extensions"] } },
      { api: { db_schema: "extensions,public" } },
    );
    expect(changeAt(result.changes, ["api", "schemas"])).toMatchObject({ class: "update" });

    const searchPath = diffWith(
      { api: { extra_search_path: ["public", "extensions"] } },
      { api: { db_extra_search_path: "extensions,public" } },
    );
    expect(changeAt(searchPath.changes, ["api", "extra_search_path"])).toMatchObject({
      class: "update",
    });
  });

  test("set-semantics arrays ignore element order", () => {
    // additional_redirect_urls is membership-only — its registry row opts
    // into set equality.
    const result = diffWith(
      { auth: { additional_redirect_urls: ["https://b.example.com", "https://a.example.com"] } },
      { auth: { uri_allow_list: "https://a.example.com,https://b.example.com" } },
    );
    expect(changeAt(result.changes, ["auth", "additional_redirect_urls"])).toBeUndefined();
  });

  test("record keys containing dots survive the classification", () => {
    // sms.test_otp is keyed by phone numbers — segment-array paths keep the
    // key intact where a dotted-string round-trip would silently lose it.
    const declared = {
      auth: {
        sms: {
          enable_confirmations: true,
          test_otp: { "415.2127777": "111111" },
        },
      },
    };
    const result = diffWith(declared, {
      auth: { sms_test_otp: "415.2127777=999999" },
    });
    expect(changeAt(result.changes, ["auth", "sms", "test_otp", "415.2127777"])).toMatchObject({
      class: "update",
      local: "111111",
      remote: "999999",
    });
  });

  test("byte-size values converge across representations", () => {
    // Local "50MiB" and the wire's byte count both canonicalize through the
    // convergence normalizers (ADR 0021), so they compare equal.
    const equal = diffWith(
      { storage: { file_size_limit: "50MiB" } },
      { storage: { file_size_limit: 52428800 } },
    );
    expect(changeAt(equal.changes, ["storage", "file_size_limit"])).toBeUndefined();

    const differing = diffWith(
      { storage: { file_size_limit: "50MiB" } },
      { storage: { file_size_limit: 1048576 } },
    );
    expect(changeAt(differing.changes, ["storage", "file_size_limit"])).toMatchObject({
      class: "update",
    });
  });

  test("declared secret values are masked, never compared, never counted", () => {
    const declared = {
      auth: {
        external: { github: { enabled: true, client_id: "id", secret: "env(GITHUB_SECRET)" } },
      },
    };
    const result = diffWith(declared, {
      auth: { external_github_enabled: true, external_github_client_id: "id" },
    });
    expect(result.masked).toContainEqual(["auth", "external", "github", "secret"]);
    expect(changeAt(result.changes, ["auth", "external", "github", "secret"])).toBeUndefined();
    expect(result.counts).toEqual({ update: 0, remote_only: 0, local_only: 0, total: 0 });
  });

  test("undeclared secrets are neither masked nor reported", () => {
    const result = diffWith({}, { auth: { smtp_pass: "hmac-of-something" } });
    expect(result.masked).toEqual([]);
    expect(result.changes.filter((change) => change.path.includes("pass"))).toEqual([]);
  });

  test("env references annotate the change with every involved variable", () => {
    const result = diffWith({ api: { max_rows: 500 } }, { api: { max_rows: 1000 } }, [
      { path: ["api", "max_rows"], source: "environment", envVariables: ["PGRST_MAX_ROWS"] },
    ]);
    expect(changeAt(result.changes, ["api", "max_rows"])).toMatchObject({
      envVariables: ["PGRST_MAX_ROWS"],
    });
  });

  test("changes are ordered by path and counts add up", () => {
    const result = diffWith(
      { api: { max_rows: 5 }, auth: { site_url: "https://local.example.com" } },
      { api: { max_rows: 6 }, auth: {}, database: { postgres_settings: { work_mem: "64MB" } } },
    );
    const joined = result.changes.map((change) => change.path.join("\u0000"));
    expect(joined).toEqual([...joined].sort());
    expect(result.counts.update).toBe(1);
    expect(result.counts.remote_only).toBe(1);
    expect(result.counts.local_only).toBe(1);
    expect(result.counts.total).toBe(3);
  });
});

describe("absence policy", () => {
  test("absent-is-hands-off masks a fixed-list field (auth.captcha) out of local entirely, reporting remote_only with local: undefined", () => {
    // `auth.captcha` is never declared; `applyRawPresenceMask`'s fixed list removes it from the
    // local projection entirely rather than defaulting it, so this can't be mistaken for "push
    // the default over the remote customization".
    const result = diffWith(
      {},
      { auth: { security_captcha_enabled: true, security_captcha_provider: "hcaptcha" } },
    );
    expect(result.absencePolicy).toBe("absent-is-hands-off");
    expect(changeAt(result.changes, ["auth", "captcha", "enabled"])).toMatchObject({
      class: "remote_only",
      local: undefined,
      declared: false,
    });
  });

  test("documents the hazardous cell: absent-is-default reports remote_only with the schema default masquerading as local", () => {
    // No `document` supplied — the exact Studio-shaped call `ConfigAbsencePolicy` is named for.
    // With no raw document to mask against, the local projection carries the schema default as
    // though it were declared. This documents the one hazardous cell: a consumer that treated
    // `remote_only` as "safe to push" here would silently revert a real customization.
    const result = diffProjectConfig({
      local: { config: decodeCliConfig({}) },
      remote: fromApiProjectConfig({
        auth: { security_captcha_enabled: true, security_captcha_provider: "hcaptcha" },
      }),
    });
    expect(result.absencePolicy).toBe("absent-is-default");
    expect(changeAt(result.changes, ["auth", "captcha", "enabled"])).toMatchObject({
      class: "remote_only",
      local: false,
      declared: false,
    });
  });

  test("a comparable path outside the raw-presence mask's fixed list classifies identically under both policies", () => {
    // api.max_rows isn't one of the fixed masked paths, so both call shapes rely on the
    // generic `declared` mechanism alone to avoid misclassifying it as `update`.
    const attributes = { api: { max_rows: 250 } };
    const withDocument = diffWith({}, attributes);
    const withoutDocument = diffProjectConfig({
      local: { config: decodeCliConfig({}) },
      remote: fromApiProjectConfig(attributes),
    });
    expect(changeAt(withDocument.changes, ["api", "max_rows"])).toMatchObject({
      class: "remote_only",
    });
    expect(changeAt(withoutDocument.changes, ["api", "max_rows"])).toMatchObject({
      class: "remote_only",
    });
  });

  test("absencePolicy round-trips: hands-off when a document is supplied, default when it is omitted", () => {
    const withDocument = diffWith({}, {});
    expect(withDocument.absencePolicy).toBe("absent-is-hands-off");

    const withoutDocument = diffProjectConfig({
      local: { config: decodeCliConfig({}) },
      remote: fromApiProjectConfig({}),
    });
    expect(withoutDocument.absencePolicy).toBe("absent-is-default");
  });
});

describe("isEqualConfigValue", () => {
  test("sequence semantics by default", () => {
    expect(isEqualConfigValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(isEqualConfigValue(["a", "b"], ["b", "a"])).toBe(false);
    expect(isEqualConfigValue(["1"], [1])).toBe(true);
    expect(isEqualConfigValue(["a"], ["a", "a"])).toBe(false);
  });

  test("set semantics on request are membership-only", () => {
    expect(isEqualConfigValue(["a", "b"], ["b", "a"], "set")).toBe(true);
    // Duplicates carry no meaning for a set-mode field — identical membership with different
    // duplicate counts is not drift.
    expect(isEqualConfigValue(["a", "a", "b"], ["a", "b", "b"], "set")).toBe(true);
    expect(isEqualConfigValue(["a", "a"], ["a", "b"], "set")).toBe(false);
    expect(isEqualConfigValue(["a", "b"], ["a"], "set")).toBe(false);
  });

  test("type-aware scalars", () => {
    expect(isEqualConfigValue("8080", 8080)).toBe(true);
    expect(isEqualConfigValue(8080, "8080")).toBe(true);
    expect(isEqualConfigValue("true", true)).toBe(true);
    expect(isEqualConfigValue(false, "false")).toBe(true);
    expect(isEqualConfigValue("", 0)).toBe(false);
    expect(isEqualConfigValue("8080x", 8080)).toBe(false);
    expect(isEqualConfigValue(undefined, "")).toBe(false);
  });
});
