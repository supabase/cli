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
 * Builds the diff input the way the command layer does: the local operand is
 * the loaded `{config, document}` pair (so raw-presence masking applies and
 * the declared-key set comes from the same load), the remote operand is
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
    // The primary someone-changed-it-in-the-dashboard case: the file is
    // silent, the local projection carries the schema default (1000), and a
    // push would overwrite the remote 250 with it — the change must say so.
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
    // db.ssl_enforcement is raw-presence-masked on the document arm (ADR
    // 0021), so its local projection is silent when the file never declares
    // it; the platform reporting the unconfigured state is not drift.
    const clean = diffWith({}, { database: { ssl_enforced: false } });
    expect(changeAt(clean.changes, ["db", "ssl_enforcement", "enabled"])).toBeUndefined();

    const drifted = diffWith({}, { database: { ssl_enforced: true } });
    expect(changeAt(drifted.changes, ["db", "ssl_enforcement", "enabled"])).toMatchObject({
      class: "remote_only",
      remote: true,
    });
  });

  test("push-gated containers fall back to the raw schema default as baseline", () => {
    // The registry maps network-restriction CIDRs unconditionally, but push
    // gates them on the local `enabled` toggle, so the default projection is
    // silent on them. The raw schema default (allow-all) IS the platform's
    // unconfigured state — reporting it would flag every untouched project.
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
    // GoTrue reports 0 hours for unconfigured session bounds; the transform
    // canonicalizes that to the STRING "0s", which no type-level zero check
    // recognizes — the registry row's `unconfiguredValue` must. An untouched
    // project reporting both bounds is clean; a real timebox is drift.
    const clean = diffWith({}, { auth: { sessions_timebox: 0, sessions_inactivity_timeout: 0 } });
    expect(clean.changes).toEqual([]);

    const drifted = diffWith({}, { auth: { sessions_timebox: 24 } });
    expect(changeAt(drifted.changes, ["auth", "sessions", "timebox"])).toMatchObject({
      class: "remote_only",
      remote: "24h0m0s",
    });
  });

  test("platform-default mailer subjects suppress via the row's unconfiguredValue", () => {
    // A fresh project reports the provisioning-default subject lines (pinned
    // by the recorded config_auth fixtures); the default config declares no
    // subjects, so without the row-level baseline every untouched project
    // would flag all 13 of them.
    const clean = diffWith(
      {},
      {
        auth: {
          mailer_subjects_confirmation: "Confirm Your Signup",
          mailer_subjects_password_changed_notification: "Your password has been changed",
          mailer_notifications_password_changed_enabled: false,
        },
      },
    );
    expect(clean.changes).toEqual([]);

    const drifted = diffWith(
      {},
      {
        auth: {
          mailer_subjects_confirmation: "Welcome to ACME",
          mailer_notifications_password_changed_enabled: true,
        },
      },
    );
    expect(
      changeAt(drifted.changes, ["auth", "email", "template", "confirmation", "subject"]),
    ).toMatchObject({ class: "remote_only", remote: "Welcome to ACME" });
    expect(
      changeAt(drifted.changes, ["auth", "email", "notification", "password_changed", "enabled"]),
    ).toMatchObject({ class: "remote_only", remote: true });
  });

  test("every comparable path without a config-side baseline makes a deliberate choice", () => {
    // Registry-driven guard for the remote_only suppression baseline: for
    // each comparable path the default config's projection AND the raw
    // default config are silent on, either its row declares the platform's
    // `unconfiguredValue` (and a remote report equal to it classifies clean),
    // or the platform's unconfigured report is structural ABSENCE (sentinel-
    // pruned SMTP/captcha/SMS/hook siblings, sparse postgres_settings) and a
    // zero-form remote — which absence-class paths never receive — must
    // REPORT rather than be silently swallowed by type-level zero inference.
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
      if (row !== undefined && Object.hasOwn(row, "unconfiguredValue")) {
        // The declared unconfigured value classifies clean...
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
      } else {
        // ...and a path relying on structural absence must not silently
        // swallow a zero-form value if the platform ever starts reporting
        // one: inject a zero-form leaf directly into the remote projection
        // (bypassing the normalizer, which today omits these paths) and
        // assert it REPORTS.
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

  test("a declared path the projection cannot push surfaces in unmanaged, never as a false clean", () => {
    // `auth.oauth_server` is dropped from the document projection entirely —
    // push has no oauth_server handling — so a declared `enabled = true`
    // disagreeing with the remote's `false` cannot be a change entry. It must
    // surface in `unmanaged` so the clean changes list is visibly partial.
    const result = diffWith(
      { auth: { oauth_server: { enabled: true } } },
      { auth: { oauth_server_enabled: false } },
    );
    expect(result.changes).toEqual([]);
    expect(result.unmanaged).toContainEqual(["auth", "oauth_server", "enabled"]);
  });

  test("declared siblings of a disabled container surface in unmanaged", () => {
    // Push writes only the disable sentinel for a disabled SMTP block, so a
    // declared host is never communicated — the projection prunes it and the
    // unmanaged list says so.
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

  test("sequence arrays register reordering as drift", () => {
    // api.schemas is order-significant (the first entry is PostgREST's
    // default schema), so local ["public","extensions"] vs the wire's
    // "extensions,public" is a real difference — in both declared and
    // undeclared classifications.
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

describe("isEqualConfigValue", () => {
  test("sequence semantics by default", () => {
    expect(isEqualConfigValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(isEqualConfigValue(["a", "b"], ["b", "a"])).toBe(false);
    expect(isEqualConfigValue(["1"], [1])).toBe(true);
    expect(isEqualConfigValue(["a"], ["a", "a"])).toBe(false);
  });

  test("set semantics on request are membership-only", () => {
    expect(isEqualConfigValue(["a", "b"], ["b", "a"], "set")).toBe(true);
    // Duplicates carry no meaning for a set-mode field — identical
    // membership with different duplicate counts is NOT drift.
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
