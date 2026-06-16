import { describe, expect, it } from "vitest";

import {
  encodeLegacyLintResults,
  filterLegacyLintResult,
  LEGACY_LINT_LEVEL_ENUM,
  type LegacyLintResult,
  parseLegacyLintResult,
} from "./lint.format.ts";

describe("LEGACY_LINT_LEVEL_ENUM (Go toEnum, prefix match)", () => {
  it("maps warning/error and the plpgsql_check 'warning extra' level", () => {
    expect(LEGACY_LINT_LEVEL_ENUM.toEnum("warning")).toBe(0);
    expect(LEGACY_LINT_LEVEL_ENUM.toEnum("error")).toBe(1);
    expect(LEGACY_LINT_LEVEL_ENUM.toEnum("warning extra")).toBe(0);
    expect(LEGACY_LINT_LEVEL_ENUM.toEnum("none")).toBe(-1);
  });
});

describe("parseLegacyLintResult", () => {
  it("parses the plpgsql_check payload and overrides function with <schema>.<proname>", () => {
    const result = parseLegacyLintResult(
      `{"function":"22751","issues":[{"level":"error","message":"boom"}]}`,
      "public.f1",
    );
    expect(result.function).toBe("public.f1");
    expect(result.issues).toEqual([{ level: "error", message: "boom" }]);
  });

  it("drops empty omitempty fields and keeps nested statement/query", () => {
    const result = parseLegacyLintResult(
      `{"issues":[{"level":"warning","message":"m","statement":{"lineNumber":"6","text":"RAISE"},"hint":"","context":"ctx"}]}`,
      "public.f",
    );
    expect(result.issues[0]).toEqual({
      level: "warning",
      message: "m",
      statement: { lineNumber: "6", text: "RAISE" },
      context: "ctx",
    });
  });

  it("throws on malformed json (Go's failed to marshal json path)", () => {
    expect(() => parseLegacyLintResult("malformed", "public.f")).toThrow();
  });

  it("throws on Go-rejected shapes (top-level array/scalar, non-array issues, scalar entry)", () => {
    // Go's json.Unmarshal into lint.Result returns an UnmarshalTypeError for these
    // shapes; the handler maps the throw to LegacyDbLintMalformedJsonError. The old
    // parser silently coerced them to an empty result (false "no lint errors").
    expect(() => parseLegacyLintResult("[]", "public.f")).toThrow();
    expect(() => parseLegacyLintResult("42", "public.f")).toThrow();
    expect(() => parseLegacyLintResult(`{"issues":"nope"}`, "public.f")).toThrow();
    expect(() => parseLegacyLintResult(`{"issues":{}}`, "public.f")).toThrow();
    expect(() => parseLegacyLintResult(`{"issues":["not-an-object"]}`, "public.f")).toThrow();
  });

  it("throws on issue fields with the wrong JSON type (Go UnmarshalTypeError)", () => {
    // Go's lint.Issue / lint.Statement / lint.Query string fields reject a
    // non-string; a present non-object statement/query is also a type error.
    // The old parser coerced these via String(...).
    expect(() =>
      parseLegacyLintResult(`{"issues":[{"level":123,"message":"m"}]}`, "public.f"),
    ).toThrow();
    expect(() =>
      parseLegacyLintResult(`{"issues":[{"level":"warning","message":true}]}`, "public.f"),
    ).toThrow();
    expect(() =>
      parseLegacyLintResult(
        `{"issues":[{"level":"warning","message":"m","statement":{"lineNumber":6}}]}`,
        "public.f",
      ),
    ).toThrow();
    expect(() =>
      parseLegacyLintResult(
        `{"issues":[{"level":"warning","message":"m","statement":"nope"}]}`,
        "public.f",
      ),
    ).toThrow();
  });

  it("throws on a present non-string top-level function field, accepts string/absent", () => {
    // Go's Result.Function is a string; json.Unmarshal rejects a non-string
    // before `r.Function` is overridden with <schema>.<name> (lint.go:150-154).
    expect(() => parseLegacyLintResult(`{"function":123,"issues":[]}`, "public.f")).toThrow();
    expect(parseLegacyLintResult(`{"function":"x","issues":[]}`, "public.f")).toEqual({
      function: "public.f",
      issues: [],
    });
    expect(parseLegacyLintResult(`{"issues":[]}`, "public.f")).toEqual({
      function: "public.f",
      issues: [],
    });
  });

  it("tolerates Go-accepted shapes (null, missing issues, unknown fields)", () => {
    // Go leaves the struct at zero on a top-level null and has no DisallowUnknownFields.
    expect(parseLegacyLintResult("null", "public.f")).toEqual({ function: "public.f", issues: [] });
    expect(parseLegacyLintResult("{}", "public.f")).toEqual({ function: "public.f", issues: [] });
    expect(parseLegacyLintResult(`{"issues":null}`, "public.f")).toEqual({
      function: "public.f",
      issues: [],
    });
    expect(parseLegacyLintResult(`{"unknown":1,"issues":[]}`, "public.f")).toEqual({
      function: "public.f",
      issues: [],
    });
  });

  it("decodes a null array element to the zero-value Issue{} (Go encoding/json behavior)", () => {
    // Go's json.Unmarshal decodes a null element in []lint.Issue as the zero-value
    // Issue{} (level: "", message: ""). It is included in the slice and later
    // filtered out by filterLegacyLintResult since toEnum("") returns -1.
    const result = parseLegacyLintResult(`{"issues":[null]}`, "public.f");
    expect(result.issues).toEqual([{ level: "", message: "" }]);
  });

  it("null element alongside real issues normalizes to zero-value without throwing", () => {
    const result = parseLegacyLintResult(
      `{"issues":[null,{"level":"error","message":"boom"}]}`,
      "public.f",
    );
    expect(result.issues).toEqual([
      { level: "", message: "" },
      { level: "error", message: "boom" },
    ]);
  });
});

describe("filterLegacyLintResult", () => {
  const result: ReadonlyArray<LegacyLintResult> = [
    {
      function: "public.f1",
      issues: [
        { level: "warning", message: "test 1a" },
        { level: "error", message: "test 1b" },
      ],
    },
    { function: "private.f2", issues: [{ level: "warning extra", message: "test 2" }] },
  ];

  it("keeps every result at the warning threshold", () => {
    expect(filterLegacyLintResult(result, LEGACY_LINT_LEVEL_ENUM.toEnum("warning"))).toEqual(
      result,
    );
  });

  it("drops warning-only results at the error threshold", () => {
    expect(filterLegacyLintResult(result, LEGACY_LINT_LEVEL_ENUM.toEnum("error"))).toEqual([
      { function: "public.f1", issues: [{ level: "error", message: "test 1b" }] },
    ]);
  });
});

describe("encodeLegacyLintResults (Go printResultJSON byte parity)", () => {
  it("emits struct-order keys, drops empty omitempty fields, trailing newline", () => {
    const results: ReadonlyArray<LegacyLintResult> = [
      {
        function: "public.f1",
        issues: [
          {
            level: "error",
            message: `record "r" has no field "c"`,
            statement: { lineNumber: "6", text: "RAISE" },
            context: `SQL expression "r.c"`,
            sqlState: "42703",
          },
        ],
      },
    ];
    expect(encodeLegacyLintResults(results)).toBe(
      [
        "[",
        "  {",
        '    "function": "public.f1",',
        '    "issues": [',
        "      {",
        '        "level": "error",',
        '        "message": "record \\"r\\" has no field \\"c\\"",',
        '        "statement": {',
        '          "lineNumber": "6",',
        '          "text": "RAISE"',
        "        },",
        '        "context": "SQL expression \\"r.c\\"",',
        '        "sqlState": "42703"',
        "      }",
        "    ]",
        "  }",
        "]",
        "",
      ].join("\n"),
    );
  });
});
