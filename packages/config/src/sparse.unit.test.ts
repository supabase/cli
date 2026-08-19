import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { ProjectConfigSchema } from "./base.ts";
import { getDefaultProjectConfig, omitDefaultValues, subtractProjectConfig } from "./sparse.ts";

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

describe("getDefaultProjectConfig", () => {
  test("all schema defaults are mutually valid", () => {
    // Decoding `{}` runs every business-rule check embedded in the schema, so
    // a future default that conflicts with another fails here, loudly, rather
    // than at import time in some consumer.
    expect(() => getDefaultProjectConfig()).not.toThrow();
  });

  test("materializes known schema defaults across sections", () => {
    const defaults = getDefaultProjectConfig();
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
    const defaults = getDefaultProjectConfig();
    expect("project_id" in defaults).toBe(false);
    expect("external_url" in defaults.api).toBe(false);
  });

  test("is deeply frozen so mutation cannot poison the shared baseline", () => {
    const defaults = getDefaultProjectConfig();
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
    expect(omitDefaultValues(getDefaultProjectConfig())).toEqual({});
    expect(omitDefaultValues(decodeProjectConfig({}))).toEqual({});
  });

  test("keeps an overridden leaf and drops its default-valued siblings", () => {
    const config = decodeProjectConfig({ api: { max_rows: 500 } });
    expect(omitDefaultValues(config)).toEqual({ api: { max_rows: 500 } });
  });

  test("array comparison is order-sensitive", () => {
    const reordered = decodeProjectConfig({ api: { schemas: ["graphql_public", "public"] } });
    expect(omitDefaultValues(reordered)).toEqual({
      api: { schemas: ["graphql_public", "public"] },
    });

    const exact = decodeProjectConfig({ api: { schemas: ["public", "graphql_public"] } });
    expect(omitDefaultValues(exact)).toEqual({});
  });

  test("sections emptied by subtraction disappear, cascading upward", () => {
    // `api.tls.enabled` defaults to `false`: the leaf is pruned, leaving
    // `tls: {}`, which is dropped, leaving `api: {}`, which is dropped.
    const config = decodeProjectConfig({ api: { tls: { enabled: false } } });
    expect(omitDefaultValues(config)).toEqual({});
  });

  test("optional fields with no default always survive when present", () => {
    const config = decodeProjectConfig({
      project_id: "my-project",
      api: { external_url: "https://api.example.com" },
    });
    expect(omitDefaultValues(config)).toEqual({
      project_id: "my-project",
      api: { external_url: "https://api.example.com" },
    });
  });

  test("record entries absent from the defaults pass through whole", () => {
    const config = decodeProjectConfig({ functions: { hello: { verify_jwt: false } } });
    const sparse = omitDefaultValues(config);
    expect(sparse.functions).toEqual(config.functions);
  });

  test("remotes pass through untouched, even when set to global defaults", () => {
    // `api.max_rows = 1000` IS the global default, but inside a remote block
    // it overrides whatever the base config resolves to — subtracting it
    // against global defaults would silently change the branch's effective
    // value. See ADR 0018: a remote block's baseline is the merged base
    // config, never the default config.
    const config = decodeProjectConfig({
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
    const sparse = omitDefaultValues(decodeProjectConfig(raw));
    const functions = sparse.functions ?? {};
    expect(Object.hasOwn(functions, "__proto__")).toBe(true);
    const entry = Object.getOwnPropertyDescriptor(functions, "__proto__")?.value;
    expect(entry).toMatchObject({ verify_jwt: false });
    // The walk must not have poisoned the container's prototype either.
    expect(Object.getPrototypeOf(functions)).toBe(Object.prototype);
  });

  test("does not mutate its input", () => {
    const config = decodeProjectConfig({
      api: { max_rows: 500 },
      remotes: { staging: { project_id: "abcdefghijklmnopqrst" } },
    });
    const before = structuredClone(config);
    omitDefaultValues(config);
    expect(config).toEqual(before);
  });
});

describe("subtractProjectConfig", () => {
  test("subtracting a config from itself yields an empty overlay", () => {
    const config = decodeProjectConfig({ api: { max_rows: 500 } });
    expect(subtractProjectConfig(config, config)).toEqual({});
  });

  test("accepts a decoded remote block against the merged base config", () => {
    // The ADR 0018 call shape for CLI-2156: a remote block has the root
    // sections but no nested `remotes`, and must be accepted without a cast.
    const config = decodeProjectConfig({
      api: { max_rows: 500 },
      remotes: { staging: { project_id: "abcdefghijklmnopqrst", api: { max_rows: 1000 } } },
    });
    const base = decodeProjectConfig({ api: { max_rows: 500 } });
    const staging = config.remotes["staging"];
    expect(staging).toBeDefined();
    if (staging === undefined) return;
    expect(subtractProjectConfig(staging, base)).toEqual({
      project_id: "abcdefghijklmnopqrst",
      api: { max_rows: 1000 },
    });
  });

  test("subtraction is directional against the baseline, not the defaults", () => {
    // The CLI-2156 remote-block scenario: subtract a merged effective config
    // against the merged BASE config. `api.max_rows: 1000` equals the global
    // default but differs from the baseline's 500 — kept. `db.port: 54399`
    // differs from the global default but equals the baseline's — removed.
    const baseline = decodeProjectConfig({ api: { max_rows: 500 }, db: { port: 54399 } });
    const config = decodeProjectConfig({ api: { max_rows: 1000 }, db: { port: 54399 } });
    expect(subtractProjectConfig(config, baseline)).toEqual({ api: { max_rows: 1000 } });
  });
});
