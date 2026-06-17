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

  it("returns an empty array for Go zero-value shapes (null, missing/null lints)", () => {
    // Go's json.Unmarshal leaves the struct at zero on a top-level null or an
    // absent/null `lints`, yielding no lints (No issues found).
    expect(apiResponseToLegacyAdvisorLints(null)).toEqual([]);
    expect(apiResponseToLegacyAdvisorLints({})).toEqual([]);
    expect(apiResponseToLegacyAdvisorLints({ lints: null })).toEqual([]);
  });

  it("null lints element becomes zero-value lint (Go encoding/json nil-slice decode parity)", () => {
    // Go's encoding/json decodes a null slice element to the zero-value struct,
    // not an UnmarshalTypeError. The zero lint has empty strings and nil categories.
    const result = apiResponseToLegacyAdvisorLints({
      lints: [
        null,
        {
          name: "rls_disabled",
          level: "ERROR",
          facing: "EXTERNAL",
          categories: ["SECURITY"],
          cache_key: "ck",
        },
      ],
    });
    // null → zero-value lint (not an error)
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: "",
      title: "",
      level: "",
      facing: "",
      categories: null,
      description: "",
      detail: "",
      remediation: "",
      cacheKey: "",
    });
    // valid sibling is preserved
    expect(result[1]?.name).toBe("rls_disabled");
    expect(result[1]?.level).toBe("ERROR");
  });

  it("null categories element becomes empty string (Go encoding/json []string null-element parity)", () => {
    // Go's encoding/json decodes a null element inside a []string to the zero
    // string "", not an UnmarshalTypeError.
    const result = apiResponseToLegacyAdvisorLints({
      lints: [{ name: "x", categories: [null, "SECURITY"] }],
    });
    expect(result[0]?.categories).toEqual(["", "SECURITY"]);
  });

  it("throws on structural shapes Go's typed decode rejects", () => {
    // Go decodes into V1ProjectAdvisorsResponse; a type mismatch on a container
    // field is an UnmarshalTypeError → non-zero failure (not "No issues found").
    // The previous tolerant parser wrongly coerced these to []. Keep the
    // string-enum tolerance (above), but reject wrong-typed containers.
    expect(() => apiResponseToLegacyAdvisorLints("nope")).toThrow();
    expect(() => apiResponseToLegacyAdvisorLints([])).toThrow();
    expect(() => apiResponseToLegacyAdvisorLints({ lints: "nope" })).toThrow();
    expect(() => apiResponseToLegacyAdvisorLints({ lints: ["not-an-object"] })).toThrow();
    expect(() =>
      apiResponseToLegacyAdvisorLints({ lints: [{ name: "x", categories: "SECURITY" }] }),
    ).toThrow();
    expect(() =>
      apiResponseToLegacyAdvisorLints({ lints: [{ name: "x", metadata: "nope" }] }),
    ).toThrow();
    expect(() =>
      apiResponseToLegacyAdvisorLints({
        lints: [{ name: "x", metadata: { fkey_columns: "nope" } }],
      }),
    ).toThrow();
  });

  it("throws on scalar fields with the wrong JSON type (Go UnmarshalTypeError)", () => {
    // Go's typed decode rejects a non-string for a string/`type X string` field
    // and a non-string `[]string` element — even though it tolerates any string
    // VALUE. The previous parser coerced 123 -> "123" via String().
    expect(() => apiResponseToLegacyAdvisorLints({ lints: [{ name: 123 }] })).toThrow();
    expect(() =>
      apiResponseToLegacyAdvisorLints({ lints: [{ name: "x", level: true }] }),
    ).toThrow();
    expect(() =>
      apiResponseToLegacyAdvisorLints({ lints: [{ name: "x", categories: [1] }] }),
    ).toThrow();
    expect(() =>
      apiResponseToLegacyAdvisorLints({ lints: [{ name: "x", metadata: { schema: 5 } }] }),
    ).toThrow();
  });

  it("treats absent scalar fields as the empty-string zero value (Go json)", () => {
    // A missing field decodes to "" with no error; only present-but-wrong-type fails.
    // `categories` absent → nil slice → encoded as `null` (advisors.go:197-199
    // append-onto-nil with zero iterations; no omitempty on the field).
    const lints = apiResponseToLegacyAdvisorLints({ lints: [{ name: "only_name" }] });
    expect(lints[0]).toEqual({
      name: "only_name",
      title: "",
      level: "",
      facing: "",
      categories: null,
      description: "",
      detail: "",
      remediation: "",
      cacheKey: "",
    });
  });

  it("collapses null and empty categories to null (Go nil-slice parity)", () => {
    // null categories → nil slice → "categories": null
    const fromNull = apiResponseToLegacyAdvisorLints({
      lints: [{ name: "x", categories: null }],
    });
    expect(fromNull[0]?.categories).toBeNull();
    // empty [] → zero append iterations → nil slice → "categories": null
    const fromEmpty = apiResponseToLegacyAdvisorLints({
      lints: [{ name: "x", categories: [] }],
    });
    expect(fromEmpty[0]?.categories).toBeNull();
    // populated → array preserved
    const fromPopulated = apiResponseToLegacyAdvisorLints({
      lints: [{ name: "x", categories: ["SECURITY"] }],
    });
    expect(fromPopulated[0]?.categories).toEqual(["SECURITY"]);
  });

  it("normalizes null fkey_columns elements to 0 (Go encoding/json float32 zero value)", () => {
    // Go's encoding/json decodes a JSON null array element into the zero value
    // for float32 (0), not an UnmarshalTypeError. Mirror that parity.
    const result = apiResponseToLegacyAdvisorLints({
      lints: [{ name: "x", metadata: { fkey_columns: [null, 2] } }],
    });
    const meta = result[0]?.metadata as Record<string, unknown>;
    expect(meta?.["fkey_columns"]).toEqual([0, 2]);
  });

  it("normalizes a fully-null fkey_columns array to all zeros", () => {
    const result = apiResponseToLegacyAdvisorLints({
      lints: [{ name: "x", metadata: { fkey_columns: [null, null] } }],
    });
    const meta = result[0]?.metadata as Record<string, unknown>;
    expect(meta?.["fkey_columns"]).toEqual([0, 0]);
  });

  it("still throws on non-number, non-null fkey_columns elements (Go UnmarshalTypeError)", () => {
    expect(() =>
      apiResponseToLegacyAdvisorLints({
        lints: [{ name: "x", metadata: { fkey_columns: [1, "x"] } }],
      }),
    ).toThrow("cannot unmarshal advisor metadata.fkey_columns element into float32");

    expect(() =>
      apiResponseToLegacyAdvisorLints({
        lints: [{ name: "x", metadata: { fkey_columns: [1, true] } }],
      }),
    ).toThrow();
  });

  it("still throws on a non-array fkey_columns (Go UnmarshalTypeError)", () => {
    expect(() =>
      apiResponseToLegacyAdvisorLints({
        lints: [{ name: "x", metadata: { fkey_columns: "nope" } }],
      }),
    ).toThrow("cannot unmarshal advisor metadata.fkey_columns into []float32");
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

  it("emits categories:null (key present, null value) when categories is null — Go nil []string parity", () => {
    // Go has no omitempty on Lint.Categories; a nil slice encodes as
    // `"categories": null`, not omitted. Verify the key is present AND the
    // value is the literal `null` (not `[]` or absent).
    const lintWithNullCategories: LegacyAdvisorLint = {
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
    const out = encodeLegacyAdvisorLints([lintWithNullCategories]);
    expect(out).toContain('"categories": null');
    expect(out).not.toContain('"categories": []');
  });
});

describe("splitLegacyLintsSql", () => {
  it("splits on the first ';\\n\\n' into setup + query", () => {
    const [setup, query] = splitLegacyLintsSql();
    expect(setup).toBe("set local search_path = ''");
    expect(query.startsWith("(")).toBe(true);
  });
});
