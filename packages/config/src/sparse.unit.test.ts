import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { CliConfigSchema } from "./base.ts";
import { getDefaultCliConfig, omitDefaultValues, subtractCliConfig } from "./sparse.ts";

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

describe("getDefaultCliConfig", () => {
  test("all schema defaults are mutually valid", () => {
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
    // `max_rows: 1000` matches the global default but must still survive: it's set
    // inside the remote block.
    const config = decodeCliConfig({
      api: { max_rows: 500 },
      remotes: { staging: { project_id: "abcdefghijklmnopqrst", api: { max_rows: 1000 } } },
    });
    const sparse = omitDefaultValues(config);
    expect(sparse.remotes).toEqual(config.remotes);
    expect(sparse.api).toEqual({ max_rows: 500 });
  });

  test("preserves a record entry named __proto__ as an own data property", () => {
    const raw: unknown = JSON.parse('{"functions": {"__proto__": {"verify_jwt": false}}}');
    const sparse = omitDefaultValues(decodeCliConfig(raw));
    const functions = sparse.functions ?? {};
    expect(Object.hasOwn(functions, "__proto__")).toBe(true);
    const entry = Object.getOwnPropertyDescriptor(functions, "__proto__")?.value;
    expect(entry).toMatchObject({ verify_jwt: false });
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
    expect(overlay).not.toHaveProperty("db");
  });

  test("subtraction is directional against the baseline, not the defaults", () => {
    const baseline = decodeCliConfig({ api: { max_rows: 500 }, db: { port: 54399 } });
    const config = decodeCliConfig({ api: { max_rows: 1000 }, db: { port: 54399 } });
    expect(subtractCliConfig(config, baseline)).toEqual({ api: { max_rows: 1000 } });
  });
});

describe("EffectiveConfig operand widening (CLI-2230)", () => {
  test("subtractCliConfig: equal sparse operands cancel out entirely", () => {
    expect(subtractCliConfig({ api: { max_rows: 100 } }, { api: { max_rows: 100 } })).toEqual({});
  });

  test("subtractCliConfig: an empty value operand reports nothing, regardless of the baseline", () => {
    expect(subtractCliConfig({}, { api: { max_rows: 100 }, db: { port: 54399 } })).toEqual({});
  });

  test("subtractCliConfig: a field absent from the baseline is kept verbatim", () => {
    expect(subtractCliConfig({ api: { max_rows: 100 } }, {})).toEqual({ api: { max_rows: 100 } });
  });

  test("omitDefaultValues: a sparse value differing from schema defaults survives untouched", () => {
    expect(omitDefaultValues({ api: { max_rows: 500 } })).toEqual({ api: { max_rows: 500 } });
  });

  test("omitDefaultValues: a sparse value equal to the schema default is subtracted away", () => {
    const defaultMaxRows = getDefaultCliConfig().api.max_rows;
    expect(omitDefaultValues({ api: { max_rows: defaultMaxRows } })).toEqual({});
  });

  test("omitDefaultValues: does not flood in default-valued siblings the sparse operand never mentioned", () => {
    const sparse = omitDefaultValues({ api: { max_rows: 500, extra_search_path: [] } });
    expect(sparse).toEqual({ api: { max_rows: 500, extra_search_path: [] } });
    expect(Object.keys(sparse.api ?? {}).sort()).toEqual(["extra_search_path", "max_rows"]);
  });
});
