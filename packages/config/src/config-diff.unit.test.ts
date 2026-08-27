import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { CliConfigSchema } from "./base.ts";
import {
  diffProjectConfig,
  isEqualConfigValue,
  type ConfigChange,
  type DiffProjectConfigOptions,
} from "./config-diff.ts";
import { fromApiProjectConfig, fromConfigDocument } from "./project-config/project-config.ts";

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

/**
 * Builds the diff input the way the command layer does: the local operand is
 * `fromConfigDocument` over the decoded config WITH its raw document (so
 * raw-presence masking applies), the remote operand is `fromApiProjectConfig`
 * over bare v2 `data.attributes`, and `declared` is the raw document.
 */
function diffWith(
  declared: Record<string, unknown>,
  attributes: Record<string, unknown>,
  extra?: Partial<DiffProjectConfigOptions>,
) {
  return diffProjectConfig({
    local: fromConfigDocument({ config: decodeCliConfig(declared), document: declared }),
    remote: fromApiProjectConfig(attributes),
    declared,
    ...extra,
  });
}

function changeAt(changes: ReadonlyArray<ConfigChange>, path: string): ConfigChange | undefined {
  return changes.find((change) => change.path === path);
}

describe("diffProjectConfig classification", () => {
  test("an undefined declared document means nothing is declared", () => {
    const result = diffProjectConfig({
      local: fromConfigDocument(decodeCliConfig({})),
      remote: fromApiProjectConfig({ api: { max_rows: 250 } }),
      declared: undefined,
    });
    expect(changeAt(result.changes, "api.max_rows")).toMatchObject({ class: "remote_only" });
  });

  test("declared value differing from remote is an update", () => {
    const result = diffWith({ api: { max_rows: 500 } }, { api: { max_rows: 1000 } });
    const change = changeAt(result.changes, "api.max_rows");
    expect(change).toMatchObject({ class: "update", local: 500, remote: 1000 });
    expect(result.counts.update).toBe(1);
  });

  test("declared value equal to remote is not a difference", () => {
    const result = diffWith({ api: { max_rows: 500 } }, { api: { max_rows: 500 } });
    expect(result.changes).toEqual([]);
    expect(result.counts).toEqual({ update: 0, remote_only: 0, local_only: 0 });
  });

  test("remote value at the schema default is suppressed when undeclared", () => {
    const result = diffWith({}, { api: { max_rows: 1000 } });
    expect(changeAt(result.changes, "api.max_rows")).toBeUndefined();
  });

  test("remote value off the schema default is remote_only when undeclared", () => {
    const result = diffWith({}, { api: { max_rows: 250 } });
    const change = changeAt(result.changes, "api.max_rows");
    expect(change).toMatchObject({ class: "remote_only", local: undefined, remote: 250 });
  });

  test("raw-presence-masked sections suppress zero-valued remotes", () => {
    // db.ssl_enforcement is raw-presence-masked on the document arm (ADR
    // 0021), so its local projection is silent when the file never declares
    // it; the platform reporting the unconfigured state is not drift.
    const clean = diffWith({}, { database: { ssl_enforced: false } });
    expect(changeAt(clean.changes, "db.ssl_enforcement.enabled")).toBeUndefined();

    const drifted = diffWith({}, { database: { ssl_enforced: true } });
    expect(changeAt(drifted.changes, "db.ssl_enforcement.enabled")).toMatchObject({
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
    expect(changeAt(drifted.changes, "db.network_restrictions.allowed_cidrs")).toMatchObject({
      class: "remote_only",
      remote: ["10.0.0.0/8"],
    });
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
    expect(changeAt(result.changes, "auth.site_url")).toMatchObject({
      class: "local_only",
      local: "https://local.example.com",
      remote: undefined,
    });
  });

  test("a wholly absent block turns its declared properties local_only", () => {
    const result = diffWith({ db: { settings: { max_connections: 120 } } }, {});
    expect(changeAt(result.changes, "db.settings.max_connections")).toMatchObject({
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

  test("array comparison ignores element order", () => {
    const result = diffWith(
      { api: { schemas: ["graphql_public", "public"] } },
      { api: { db_schema: "public,graphql_public" } },
    );
    expect(changeAt(result.changes, "api.schemas")).toBeUndefined();
  });

  test("byte-size values converge across representations", () => {
    // Local "50MiB" and the wire's byte count both canonicalize through the
    // convergence normalizers (ADR 0021), so they compare equal.
    const equal = diffWith(
      { storage: { file_size_limit: "50MiB" } },
      { storage: { file_size_limit: 52428800 } },
    );
    expect(changeAt(equal.changes, "storage.file_size_limit")).toBeUndefined();

    const differing = diffWith(
      { storage: { file_size_limit: "50MiB" } },
      { storage: { file_size_limit: 1048576 } },
    );
    expect(changeAt(differing.changes, "storage.file_size_limit")).toMatchObject({
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
    expect(result.masked).toContain("auth.external.github.secret");
    expect(changeAt(result.changes, "auth.external.github.secret")).toBeUndefined();
    expect(result.counts).toEqual({ update: 0, remote_only: 0, local_only: 0 });
  });

  test("undeclared secrets are neither masked nor reported", () => {
    const result = diffWith({}, { auth: { smtp_pass: "hmac-of-something" } });
    expect(result.masked).toEqual([]);
    expect(result.changes.filter((change) => change.path.includes("pass"))).toEqual([]);
  });

  test("env references annotate the change for the involved variable", () => {
    const result = diffWith(
      { api: { max_rows: 500 } },
      { api: { max_rows: 1000 } },
      { envReferences: new Map([["api.max_rows", "PGRST_MAX_ROWS"]]) },
    );
    expect(changeAt(result.changes, "api.max_rows")).toMatchObject({
      envVariable: "PGRST_MAX_ROWS",
    });
  });

  test("changes are ordered by path and counts add up", () => {
    const result = diffWith(
      { api: { max_rows: 5 }, auth: { site_url: "https://local.example.com" } },
      { api: { max_rows: 6 }, auth: {}, database: { postgres_settings: { work_mem: "64MB" } } },
    );
    const paths = result.changes.map((change) => change.path);
    expect(paths).toEqual([...paths].sort());
    expect(result.counts.update).toBe(1);
    expect(result.counts.remote_only).toBe(1);
    expect(result.counts.local_only).toBe(1);
  });
});

describe("isEqualConfigValue", () => {
  test("multiset semantics for arrays", () => {
    expect(isEqualConfigValue(["a", "b"], ["b", "a"])).toBe(true);
    expect(isEqualConfigValue(["a", "a", "b"], ["a", "b", "b"])).toBe(false);
    expect(isEqualConfigValue(["1"], [1])).toBe(true);
    expect(isEqualConfigValue(["a"], ["a", "a"])).toBe(false);
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
