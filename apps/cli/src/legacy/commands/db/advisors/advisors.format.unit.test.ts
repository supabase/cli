import { describe, expect, it } from "vitest";

import {
  apiResponseToLegacyAdvisorLints,
  encodeLegacyAdvisorLints,
  filterLegacyAdvisorLints,
  LEGACY_ADVISORS_LEVEL_ENUM,
  type LegacyAdvisorLint,
  matchesLegacyAdvisorType,
  scanLegacyAdvisorLintRow,
} from "./advisors.format.ts";
import { splitLegacyLintsSql } from "./advisors.lints-sql.ts";

const lint = (over: Partial<LegacyAdvisorLint>): LegacyAdvisorLint => ({
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

describe("LEGACY_ADVISORS_LEVEL_ENUM (Go toEnum, exact case-insensitive)", () => {
  it("maps info/warn/error in both cases", () => {
    expect(LEGACY_ADVISORS_LEVEL_ENUM.toEnum("info")).toBe(0);
    expect(LEGACY_ADVISORS_LEVEL_ENUM.toEnum("INFO")).toBe(0);
    expect(LEGACY_ADVISORS_LEVEL_ENUM.toEnum("warn")).toBe(1);
    expect(LEGACY_ADVISORS_LEVEL_ENUM.toEnum("ERROR")).toBe(2);
    expect(LEGACY_ADVISORS_LEVEL_ENUM.toEnum("nope")).toBe(-1);
  });
});

describe("matchesLegacyAdvisorType", () => {
  it("matches all, and SECURITY/PERFORMANCE categories", () => {
    const security = lint({ categories: ["SECURITY"] });
    const performance = lint({ categories: ["PERFORMANCE"] });
    expect(matchesLegacyAdvisorType(security, "all")).toBe(true);
    expect(matchesLegacyAdvisorType(security, "security")).toBe(true);
    expect(matchesLegacyAdvisorType(security, "performance")).toBe(false);
    expect(matchesLegacyAdvisorType(performance, "performance")).toBe(true);
    expect(matchesLegacyAdvisorType(performance, "security")).toBe(false);
  });
});

describe("filterLegacyAdvisorLints (maps Go TestFilterLints)", () => {
  const lints: ReadonlyArray<LegacyAdvisorLint> = [
    lint({ name: "rls_disabled", level: "ERROR", categories: ["SECURITY"] }),
    lint({ name: "unindexed_fk", level: "INFO", categories: ["PERFORMANCE"] }),
    lint({ name: "auth_exposed", level: "WARN", categories: ["SECURITY"] }),
    lint({ name: "no_primary_key", level: "WARN", categories: ["PERFORMANCE"] }),
  ];
  const names = (xs: ReadonlyArray<LegacyAdvisorLint>) => xs.map((x) => x.name);

  it("filters by type security", () => {
    expect(names(filterLegacyAdvisorLints(lints, "security", "info"))).toEqual([
      "rls_disabled",
      "auth_exposed",
    ]);
  });
  it("filters by type performance", () => {
    expect(names(filterLegacyAdvisorLints(lints, "performance", "info"))).toEqual([
      "unindexed_fk",
      "no_primary_key",
    ]);
  });
  it("filters by type all", () => {
    expect(filterLegacyAdvisorLints(lints, "all", "info")).toHaveLength(4);
  });
  it("filters by level warn", () => {
    expect(filterLegacyAdvisorLints(lints, "all", "warn")).toHaveLength(3);
  });
  it("filters by level error", () => {
    expect(names(filterLegacyAdvisorLints(lints, "all", "error"))).toEqual(["rls_disabled"]);
  });
  it("combines type and level filters", () => {
    expect(names(filterLegacyAdvisorLints(lints, "security", "error"))).toEqual(["rls_disabled"]);
  });
});

describe("scanLegacyAdvisorLintRow", () => {
  it("scans a local-database row keyed by column name, parsing jsonb metadata", () => {
    const result = scanLegacyAdvisorLintRow({
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
    const result = scanLegacyAdvisorLintRow({ name: "x", categories: [], metadata: null });
    expect("metadata" in result).toBe(false);
  });
});

describe("apiResponseToLegacyAdvisorLints (maps Go TestApiResponseToLints)", () => {
  it("coerces API fields to strings and projects metadata to the known fields", () => {
    const lints = apiResponseToLegacyAdvisorLints({
      lints: [
        {
          name: "rls_disabled_in_public",
          title: "RLS disabled in public",
          level: "ERROR",
          facing: "EXTERNAL",
          categories: ["SECURITY"],
          description: "Tables without RLS",
          detail: "Table public.users",
          remediation: "https://supabase.com/docs",
          cache_key: "test_key",
          metadata: { schema: "public", entity: "public.users", type: "table", unknown: "x" },
        },
      ],
    });
    expect(lints).toHaveLength(1);
    expect(lints[0]?.name).toBe("rls_disabled_in_public");
    expect(lints[0]?.level).toBe("ERROR");
    expect(lints[0]?.categories).toEqual(["SECURITY"]);
    // Unknown metadata fields are dropped; known fields are kept in struct order.
    expect(Object.keys(lints[0]?.metadata as Record<string, unknown>)).toEqual([
      "entity",
      "schema",
      "type",
    ]);
  });

  it("accepts an unknown advisor name (closed-enum divergence guard)", () => {
    const lints = apiResponseToLegacyAdvisorLints({
      lints: [{ name: "some_brand_new_advisor", level: "WARN", categories: ["SECURITY"] }],
    });
    expect(lints[0]?.name).toBe("some_brand_new_advisor");
  });

  it("returns an empty array for a malformed response", () => {
    expect(apiResponseToLegacyAdvisorLints(null)).toEqual([]);
    expect(apiResponseToLegacyAdvisorLints({})).toEqual([]);
    expect(apiResponseToLegacyAdvisorLints({ lints: "nope" })).toEqual([]);
  });
});

describe("encodeLegacyAdvisorLints (Go outputAndCheck byte parity)", () => {
  it("emits struct-order keys, jsonb metadata, cache_key last, trailing newline", () => {
    const lints: ReadonlyArray<LegacyAdvisorLint> = [
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
    expect(encodeLegacyAdvisorLints(lints)).toBe(
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
    const out = encodeLegacyAdvisorLints([lint({ name: "n", categories: ["SECURITY"] })]);
    expect(out).not.toContain("metadata");
    expect(out).toContain('"cache_key": ""');
  });
});

describe("splitLegacyLintsSql", () => {
  it("splits on the first ';\\n\\n' into setup + query", () => {
    const [setup, query] = splitLegacyLintsSql();
    expect(setup).toBe("set local search_path = ''");
    expect(query.startsWith("(")).toBe(true);
  });
});
