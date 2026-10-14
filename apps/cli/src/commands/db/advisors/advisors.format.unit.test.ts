import { describe, expect, it } from "vitest";

import {
  apiLintsToAdvisorLints,
  encodeAdvisorLints,
  filterAdvisorLints,
  ADVISORS_LEVEL_ENUM,
  type AdvisorLint,
  matchesAdvisorType,
  scanAdvisorLintRow,
} from "./advisors.format.ts";
import { splitLintsSql } from "./advisors.lints-sql.ts";

const lint = (over: Partial<AdvisorLint>): AdvisorLint => ({
  name: over.name ?? "",
  title: over.title ?? "",
  level: over.level ?? "INFO",
  facing: over.facing ?? "EXTERNAL",
  categories: over.categories ?? [],
  description: over.description ?? "",
  detail: over.detail ?? "",
  remediation: over.remediation ?? "",
  ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
  cacheKey: over.cacheKey ?? "",
});

describe("ADVISORS_LEVEL_ENUM (Go toEnum, exact case-insensitive)", () => {
  it("maps info/warn/error in both cases", () => {
    expect(ADVISORS_LEVEL_ENUM.toEnum("info")).toBe(0);
    expect(ADVISORS_LEVEL_ENUM.toEnum("INFO")).toBe(0);
    expect(ADVISORS_LEVEL_ENUM.toEnum("warn")).toBe(1);
    expect(ADVISORS_LEVEL_ENUM.toEnum("ERROR")).toBe(2);
    expect(ADVISORS_LEVEL_ENUM.toEnum("nope")).toBe(-1);
  });
});

describe("matchesAdvisorType", () => {
  it("matches all, and SECURITY/PERFORMANCE categories", () => {
    const security = lint({ categories: ["SECURITY"] });
    const performance = lint({ categories: ["PERFORMANCE"] });
    expect(matchesAdvisorType(security, "all")).toBe(true);
    expect(matchesAdvisorType(security, "security")).toBe(true);
    expect(matchesAdvisorType(security, "performance")).toBe(false);
    expect(matchesAdvisorType(performance, "performance")).toBe(true);
    expect(matchesAdvisorType(performance, "security")).toBe(false);
  });
});

describe("filterAdvisorLints (maps Go TestFilterLints)", () => {
  const lints: ReadonlyArray<AdvisorLint> = [
    lint({ name: "rls_disabled", level: "ERROR", categories: ["SECURITY"] }),
    lint({ name: "unindexed_fk", level: "INFO", categories: ["PERFORMANCE"] }),
    lint({ name: "auth_exposed", level: "WARN", categories: ["SECURITY"] }),
    lint({ name: "no_primary_key", level: "WARN", categories: ["PERFORMANCE"] }),
  ];
  const names = (xs: ReadonlyArray<AdvisorLint>) => xs.map((x) => x.name);

  it("filters by type security", () => {
    expect(names(filterAdvisorLints(lints, "security", "info"))).toEqual([
      "rls_disabled",
      "auth_exposed",
    ]);
  });
  it("filters by type performance", () => {
    expect(names(filterAdvisorLints(lints, "performance", "info"))).toEqual([
      "unindexed_fk",
      "no_primary_key",
    ]);
  });
  it("filters by type all", () => {
    expect(filterAdvisorLints(lints, "all", "info")).toHaveLength(4);
  });
  it("filters by level warn", () => {
    expect(filterAdvisorLints(lints, "all", "warn")).toHaveLength(3);
  });
  it("filters by level error", () => {
    expect(names(filterAdvisorLints(lints, "all", "error"))).toEqual(["rls_disabled"]);
  });
  it("combines type and level filters", () => {
    expect(names(filterAdvisorLints(lints, "security", "error"))).toEqual(["rls_disabled"]);
  });
});

describe("scanAdvisorLintRow", () => {
  it("scans a local-database row keyed by column name, parsing jsonb metadata", () => {
    const result = scanAdvisorLintRow({
      name: "rls_disabled_in_public",
      title: "RLS disabled in public",
      level: "ERROR",
      facing: "EXTERNAL",
      categories: ["SECURITY"],
      description: "Detects tables without RLS.",
      detail: "Table public.users has RLS disabled",
      remediation: "https://supabase.com/docs",
      metadata: { schema: "public", name: "users", type: "table" },
      cache_key: "rls_disabled_in_public_public_users",
    });
    expect(result.name).toBe("rls_disabled_in_public");
    expect(result.categories).toEqual(["SECURITY"]);
    expect(result.metadata).toEqual({ schema: "public", name: "users", type: "table" });
    expect(result.cacheKey).toBe("rls_disabled_in_public_public_users");
  });

  it("omits metadata when the column is null", () => {
    const result = scanAdvisorLintRow({ name: "x", categories: [], metadata: null });
    expect("metadata" in result).toBe(false);
  });
});

describe("apiLintsToAdvisorLints", () => {
  const apiLint = {
    name: "rls_disabled_in_public",
    title: "RLS disabled in public",
    level: "ERROR",
    facing: "EXTERNAL",
    categories: ["SECURITY"],
    description: "Tables without RLS",
    detail: "Table public.users",
    remediation: "https://supabase.com/docs",
    cache_key: "test_key",
  };

  it("orders metadata keys by the output contract and omits absent fields", () => {
    const [mapped] = apiLintsToAdvisorLints([
      {
        ...apiLint,
        metadata: { type: "table", schema: "public", fkey_columns: [1, 2], entity: "public.users" },
      },
    ]);
    expect(Object.keys(mapped?.metadata as Record<string, unknown>)).toEqual([
      "entity",
      "fkey_columns",
      "schema",
      "type",
    ]);
    expect(mapped?.cacheKey).toBe("test_key");
  });

  it("collapses empty categories to null and omits metadata when absent", () => {
    const [mapped] = apiLintsToAdvisorLints([{ ...apiLint, categories: [] }]);
    expect(mapped?.categories).toBeNull();
    expect("metadata" in (mapped ?? {})).toBe(false);
  });
});

describe("encodeAdvisorLints (Go outputAndCheck byte parity)", () => {
  it("emits struct-order keys, jsonb metadata, cache_key last, trailing newline", () => {
    const lints: ReadonlyArray<AdvisorLint> = [
      lint({
        name: "rls_disabled_in_public",
        title: "RLS disabled in public",
        level: "ERROR",
        facing: "EXTERNAL",
        categories: ["SECURITY"],
        description: "d",
        detail: "dt",
        remediation: "https://x",
        metadata: { schema: "public", name: "users", type: "table" },
        cacheKey: "ck",
      }),
    ];
    expect(encodeAdvisorLints(lints)).toBe(
      [
        "[",
        "  {",
        '    "name": "rls_disabled_in_public",',
        '    "title": "RLS disabled in public",',
        '    "level": "ERROR",',
        '    "facing": "EXTERNAL",',
        '    "categories": [',
        '      "SECURITY"',
        "    ],",
        '    "description": "d",',
        '    "detail": "dt",',
        '    "remediation": "https://x",',
        '    "metadata": {',
        '      "schema": "public",',
        '      "name": "users",',
        '      "type": "table"',
        "    },",
        '    "cache_key": "ck"',
        "  }",
        "]",
        "",
      ].join("\n"),
    );
  });

  it("omits metadata when absent", () => {
    const out = encodeAdvisorLints([lint({ name: "n", categories: ["SECURITY"] })]);
    expect(out).not.toContain("metadata");
    expect(out).toContain('"cache_key": ""');
  });

  it("emits categories:null (key present, null value) when categories is null — Go nil []string parity", () => {
    const lintWithNullCategories: AdvisorLint = {
      name: "n",
      title: "",
      level: "",
      facing: "",
      categories: null,
      description: "",
      detail: "",
      remediation: "",
      cacheKey: "",
    };
    const out = encodeAdvisorLints([lintWithNullCategories]);
    expect(out).toContain('"categories": null');
    expect(out).not.toContain('"categories": []');
  });
});

describe("splitLintsSql", () => {
  it("splits on the first ';\\n\\n' into setup + query", () => {
    const [setup, query] = splitLintsSql();
    expect(setup).toBe("set local search_path = ''");
    expect(query.startsWith("(")).toBe(true);
  });

  it("defaults API-exposure lints to public when pgrst.db_schemas is unset", () => {
    const [, query] = splitLintsSql();
    expect(query).not.toContain("string_to_array(current_setting('pgrst.db_schemas', 't'), ',')");
    expect(query).toContain(
      "string_to_array(coalesce(current_setting('pgrst.db_schemas', 't'), 'public'), ',')",
    );
  });
});
