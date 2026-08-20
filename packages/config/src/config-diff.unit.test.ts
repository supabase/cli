import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { ProjectConfigSchema } from "./base.ts";
import {
  diffProjectConfig,
  isEqualConfigValue,
  type ConfigChange,
  type DiffProjectConfigOptions,
  type RemoteProjectConfig,
} from "./config-diff.ts";
import { MANAGED_CONFIG_PATHS, MANAGED_CONFIG_PROPERTIES } from "./config-diff.managed.ts";
import { normalizeByteSize } from "./config-diff.read.ts";

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

/**
 * Builds the diff input the way the command layer does: `declared` is the raw
 * document (key presence), `local` is its decoded effective config.
 */
function diffWith(
  declared: Record<string, unknown>,
  remote: RemoteProjectConfig,
  extra?: Partial<DiffProjectConfigOptions>,
) {
  return diffProjectConfig({
    local: decodeProjectConfig(declared),
    declared,
    remote,
    ...extra,
  });
}

function changeAt(changes: ReadonlyArray<ConfigChange>, path: string): ConfigChange | undefined {
  return changes.find((change) => change.path === path);
}

describe("managed surface", () => {
  test("declares no duplicate paths", () => {
    expect(MANAGED_CONFIG_PATHS.size).toBe(MANAGED_CONFIG_PROPERTIES.length);
  });

  test("every managed path resolves to a real schema path in the default config", () => {
    const defaults: unknown = decodeProjectConfig({});
    for (const path of MANAGED_CONFIG_PATHS) {
      let current: unknown = defaults;
      for (const segment of path.split(".")) {
        if (typeof current !== "object" || current === null) {
          throw new Error(`managed path ${path} leaves the schema at ${segment}`);
        }
        // Optional-key subtrees (db.settings, storage.image_transformation,
        // auth provider entries…) are absent from the default config; their
        // presence in the schema is asserted by the entries' unit coverage
        // below instead.
        if (!Object.hasOwn(current, segment)) {
          current = undefined;
          break;
        }
        current = (current as Record<string, unknown>)[segment];
      }
    }
  });

  test("local-only sections are unmanaged by construction", () => {
    for (const prefix of ["studio.", "local_smtp.", "edge_runtime.", "analytics.", "realtime."]) {
      for (const path of MANAGED_CONFIG_PATHS) {
        expect(path.startsWith(prefix)).toBe(false);
      }
    }
    expect(MANAGED_CONFIG_PATHS.has("api.port")).toBe(false);
    expect(MANAGED_CONFIG_PATHS.has("db.port")).toBe(false);
  });
});

describe("diffProjectConfig classification", () => {
  test("declared value differing from remote is an update", () => {
    const result = diffWith(
      { api: { max_rows: 500 } },
      { api: { max_rows: 1000, db_schema: "public,graphql_public" } },
    );
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

  test("declared value the response does not carry is local_only", () => {
    const result = diffWith(
      { api: { max_rows: 500 } },
      // api block present but without max_rows, and no other blocks at all.
      { api: { db_schema: "public" } },
    );
    const change = changeAt(result.changes, "api.max_rows");
    expect(change).toMatchObject({ class: "local_only", local: 500, remote: undefined });
  });

  test("a wholly absent block turns its declared properties local_only", () => {
    const result = diffWith({ db: { settings: { max_connections: 120 } } }, {});
    expect(changeAt(result.changes, "db.settings.max_connections")).toMatchObject({
      class: "local_only",
      local: 120,
    });
    expect(result.scope).toEqual([]);
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
    expect(result.changes).toEqual([]);
  });

  test("comma-joined remote strings trim around separators", () => {
    const result = diffWith(
      { api: { extra_search_path: ["public", "extensions"] } },
      { api: { db_extra_search_path: "public, extensions" } },
    );
    expect(result.changes).toEqual([]);
  });

  test("scalar comparison is type-aware across string/number and string/boolean", () => {
    const result = diffWith(
      {
        db: {
          settings: { max_connections: 120, track_commit_timestamp: true },
        },
      },
      {
        database: {
          postgres_settings: { max_connections: "120", track_commit_timestamp: "true" },
        },
      },
    );
    expect(result.changes).toEqual([]);
  });

  test("byte-size values compare canonically across representations", () => {
    const equal = diffWith(
      { storage: { file_size_limit: "50MiB" } },
      { storage: { file_size_limit: 52428800 } },
    );
    expect(equal.changes).toEqual([]);

    const differing = diffWith(
      { storage: { file_size_limit: "50MiB" } },
      { storage: { file_size_limit: 1048576 } },
    );
    // The reader coerces the wire's byte count to the local schema's string
    // kind before comparison, so the reported remote value is the coerced form.
    expect(changeAt(differing.changes, "storage.file_size_limit")).toMatchObject({
      class: "update",
      local: "50MiB",
      remote: "1048576",
    });
  });

  test("network restriction CIDRs split by address family", () => {
    const result = diffWith(
      {
        db: {
          network_restrictions: {
            enabled: true,
            allowed_cidrs: ["10.0.0.0/8"],
            allowed_cidrs_v6: [],
          },
        },
      },
      {
        database: {
          network_restrictions: {
            allowed_cidrs: [
              { address: "10.0.0.0/8", type: "v4" },
              { address: "fd00::/8", type: "v6" },
            ],
          },
        },
      },
    );
    expect(changeAt(result.changes, "db.network_restrictions.allowed_cidrs")).toBeUndefined();
    expect(changeAt(result.changes, "db.network_restrictions.allowed_cidrs_v6")).toMatchObject({
      class: "update",
      local: [],
      remote: ["fd00::/8"],
    });
  });

  test("declared secret values are masked, never compared, never counted", () => {
    const declared = {
      auth: { external: { github: { enabled: true, client_id: "id", secret: "shh" } } },
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

  test("scope lists exactly the blocks the response carried, in order", () => {
    const result = diffWith({}, { storage: {}, api: {}, database: {} });
    expect(result.scope).toEqual(["api", "database", "storage"]);
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
      { api: { max_rows: 5 }, storage: { file_size_limit: "1MiB" } },
      { api: { max_rows: 6 }, database: { postgres_settings: { work_mem: "64MB" } } },
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

describe("normalizeByteSize", () => {
  test("parses 1024-based human sizes case-insensitively", () => {
    expect(normalizeByteSize("50MiB")).toBe(52428800);
    expect(normalizeByteSize("50MB")).toBe(52428800);
    expect(normalizeByteSize("50mb")).toBe(52428800);
    expect(normalizeByteSize("1GiB")).toBe(1073741824);
    expect(normalizeByteSize("500")).toBe(500);
    expect(normalizeByteSize("0.5k")).toBe(512);
  });

  test("passes through numbers and unparseable strings", () => {
    expect(normalizeByteSize(52428800)).toBe(52428800);
    expect(normalizeByteSize("not-a-size")).toBe("not-a-size");
    expect(normalizeByteSize(true)).toBe(true);
  });
});
