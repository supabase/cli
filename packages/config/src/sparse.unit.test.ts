import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { CliConfigSchema } from "./base.ts";
import { getDefaultCliConfig, omitDefaultValues, subtractCliConfig } from "./sparse.ts";

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

describe("getDefaultCliConfig", () => {
  test("all schema defaults are mutually valid", () => {
    // Decoding `{}` runs every business-rule check embedded in the schema, so
    // a future default that conflicts with another fails here, loudly, rather
    // than at import time in some consumer.
    expect(() => getDefaultCliConfig()).not.toThrow();
  });

  test("materializes known schema defaults across sections", () => {
    const defaults = getDefaultCliConfig();
    expect(defaults.api.port).toBe(54321);
    expect(defaults.api.schemas).toEqual(["public", "graphql_public"]);
    expect(defaults.db.port).toBe(54322);
    expect(defaults.db.major_version).toBe(17);
    expect(defaults.auth.enabled).toBe(true);
    expect(defaults.auth.site_url).toBe("http://127.0.0.1:3000");
    expect(defaults.functions).toEqual({});
    expect(defaults.remotes).toEqual({});
  });

  test("omits optional fields that carry no default", () => {
    const defaults = getDefaultCliConfig();
    expect("project_id" in defaults).toBe(false);
    expect("external_url" in defaults.api).toBe(false);
  });

  test("is deeply frozen so mutation cannot poison the shared baseline", () => {
    const defaults = getDefaultCliConfig();
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.isFrozen(defaults.api)).toBe(true);
    expect(Object.isFrozen(defaults.api.schemas)).toBe(true);
    expect(() => {
      // @ts-expect-error -- readonly by type; pinning the runtime guard too
      defaults.api.port = 9999;
    }).toThrow(TypeError);
  });
});

describe("omitDefaultValues", () => {
  test("a fully-default config subtracts to an empty overlay", () => {
    expect(omitDefaultValues(getDefaultCliConfig())).toEqual({});
    expect(omitDefaultValues(decodeCliConfig({}))).toEqual({});
  });

  test("keeps an overridden leaf and drops its default-valued siblings", () => {
    const config = decodeCliConfig({ api: { max_rows: 500 } });
    expect(omitDefaultValues(config)).toEqual({ api: { max_rows: 500 } });
  });

  test("array comparison is order-sensitive", () => {
    const reordered = decodeCliConfig({ api: { schemas: ["graphql_public", "public"] } });
    expect(omitDefaultValues(reordered)).toEqual({
      api: { schemas: ["graphql_public", "public"] },
    });

    const exact = decodeCliConfig({ api: { schemas: ["public", "graphql_public"] } });
    expect(omitDefaultValues(exact)).toEqual({});
  });

  test("sections emptied by subtraction disappear, cascading upward", () => {
    // `api.tls.enabled` defaults to `false`: the leaf is pruned, leaving
    // `tls: {}`, which is dropped, leaving `api: {}`, which is dropped.
    const config = decodeCliConfig({ api: { tls: { enabled: false } } });
    expect(omitDefaultValues(config)).toEqual({});
  });

  test("optional fields with no default always survive when present", () => {
    const config = decodeCliConfig({
      project_id: "my-project",
      api: { external_url: "https://api.example.com" },
    });
    expect(omitDefaultValues(config)).toEqual({
      project_id: "my-project",
      api: { external_url: "https://api.example.com" },
    });
  });

  test("record entries absent from the defaults pass through whole", () => {
    const config = decodeCliConfig({ functions: { hello: { verify_jwt: false } } });
    const sparse = omitDefaultValues(config);
    expect(sparse.functions).toEqual(config.functions);
  });

  test("remotes pass through untouched, even when set to global defaults", () => {
    // `api.max_rows = 1000` IS the global default, but inside a remote block
    // it overrides whatever the base config resolves to — subtracting it
    // against global defaults would silently change the branch's effective
    // value. See ADR 0018: a remote block's baseline is the merged base
    // config, never the default config.
    const config = decodeCliConfig({
      api: { max_rows: 500 },
      remotes: { staging: { project_id: "abcdefghijklmnopqrst", api: { max_rows: 1000 } } },
    });
    const sparse = omitDefaultValues(config);
    expect(sparse.remotes).toEqual(config.remotes);
    expect(sparse.api).toEqual({ max_rows: 500 });
  });

  test("preserves a record entry named __proto__ as an own data property", () => {
    // Both smol-toml (`[functions.__proto__]`) and JSON.parse produce an own
    // `__proto__` key, and the schema decode preserves it — so the subtraction
    // walk must define it as an own data property rather than let a plain
    // `result[key] = value` assignment hit the legacy prototype setter and
    // silently drop the function from the sparse output.
    const raw: unknown = JSON.parse('{"functions": {"__proto__": {"verify_jwt": false}}}');
    const sparse = omitDefaultValues(decodeCliConfig(raw));
    const functions = sparse.functions ?? {};
    expect(Object.hasOwn(functions, "__proto__")).toBe(true);
    const entry = Object.getOwnPropertyDescriptor(functions, "__proto__")?.value;
    expect(entry).toMatchObject({ verify_jwt: false });
    // The walk must not have poisoned the container's prototype either.
    expect(Object.getPrototypeOf(functions)).toBe(Object.prototype);
  });

  test("does not mutate its input", () => {
    const config = decodeCliConfig({
      api: { max_rows: 500 },
      remotes: { staging: { project_id: "abcdefghijklmnopqrst" } },
    });
    const before = structuredClone(config);
    omitDefaultValues(config);
    expect(config).toEqual(before);
  });
});

describe("subtractCliConfig", () => {
  test("subtracting a config from itself yields an empty overlay", () => {
    const config = decodeCliConfig({ api: { max_rows: 500 } });
    expect(subtractCliConfig(config, config)).toEqual({});
  });

  test("sparsifies a branch via its merged effective config, not the decoded block", () => {
    // The ADR 0018 call shape for CLI-2156/2064: both operands are *effective*
    // configs, and the branch's is the raw remote subtree merged over the raw
    // base document BEFORE decoding. Decoding the sparse `[remotes.*]` block
    // on its own would materialize the global default `db.port = 54322` in
    // place of the omitted-and-therefore-inherited base override `54399`, and
    // the overlay would wrongly pin the branch to the global default.
    const rawBase = { api: { max_rows: 500 }, db: { port: 54399 } };
    const rawRemote = { project_id: "abcdefghijklmnopqrst", api: { max_rows: 1000 } };
    const base = decodeCliConfig(rawBase);
    const effectiveBranch = decodeCliConfig({
      ...rawBase,
      ...rawRemote,
      api: { ...rawBase.api, ...rawRemote.api },
    });
    const overlay = subtractCliConfig(effectiveBranch, base);
    expect(overlay).toEqual({
      project_id: "abcdefghijklmnopqrst",
      api: { max_rows: 1000 },
    });
    // The base-only `db.port` override the remote inherits must not surface.
    expect(overlay).not.toHaveProperty("db");
  });

  test("subtraction is directional against the baseline, not the defaults", () => {
    // The CLI-2156 remote-block scenario: subtract a merged effective config
    // against the merged BASE config. `api.max_rows: 1000` equals the global
    // default but differs from the baseline's 500 — kept. `db.port: 54399`
    // differs from the global default but equals the baseline's — removed.
    const baseline = decodeCliConfig({ api: { max_rows: 500 }, db: { port: 54399 } });
    const config = decodeCliConfig({ api: { max_rows: 1000 }, db: { port: 54399 } });
    expect(subtractCliConfig(config, baseline)).toEqual({ api: { max_rows: 1000 } });
  });
});
