import { describe, expect, it } from "vitest";

import {
  encodeLintResults,
  filterLintResult,
  LINT_LEVEL_ENUM,
  type LintResult,
  parseLintResult,
} from "./lint.format.ts";

describe("LINT_LEVEL_ENUM (Go toEnum, prefix match)", () => {
  it("maps warning/error and the plpgsql_check 'warning extra' level", () => {
    expect(LINT_LEVEL_ENUM.toEnum("warning")).toBe(0);
    expect(LINT_LEVEL_ENUM.toEnum("error")).toBe(1);
    expect(LINT_LEVEL_ENUM.toEnum("warning extra")).toBe(0);
    expect(LINT_LEVEL_ENUM.toEnum("none")).toBe(-1);
  });
});

describe("parseLintResult", () => {
  it("parses the plpgsql_check payload and overrides function with <schema>.<proname>", () => {
    const result = parseLintResult(
      `{"function":"22751","issues":[{"level":"error","message":"boom"}]}`,
      "public.f1",
    );
    expect(result.function).toBe("public.f1");
    expect(result.issues).toEqual([{ level: "error", message: "boom" }]);
  });

  it("drops empty omitempty fields and keeps nested statement/query", () => {
    const result = parseLintResult(
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
    expect(() => parseLintResult("malformed", "public.f")).toThrow();
  });

  it("throws on Go-rejected shapes (top-level array/scalar, non-array issues, scalar entry)", () => {
    // These shapes throw; the handler maps the throw to
    // DbLintMalformedJsonError. The old parser silently coerced them to
    // an empty result (false "no lint errors").
    expect(() => parseLintResult("[]", "public.f")).toThrow();
    expect(() => parseLintResult("42", "public.f")).toThrow();
    expect(() => parseLintResult(`{"issues":"nope"}`, "public.f")).toThrow();
    expect(() => parseLintResult(`{"issues":{}}`, "public.f")).toThrow();
    expect(() => parseLintResult(`{"issues":["not-an-object"]}`, "public.f")).toThrow();
  });

  it("throws on issue fields with the wrong JSON type (Go UnmarshalTypeError)", () => {
    // The issue/statement/query string fields reject a non-string; a present
    // non-object statement/query also throws. The old parser coerced these
    // via String(...).
    expect(() => parseLintResult(`{"issues":[{"level":123,"message":"m"}]}`, "public.f")).toThrow();
    expect(() =>
      parseLintResult(`{"issues":[{"level":"warning","message":true}]}`, "public.f"),
    ).toThrow();
    expect(() =>
      parseLintResult(
        `{"issues":[{"level":"warning","message":"m","statement":{"lineNumber":6}}]}`,
        "public.f",
      ),
    ).toThrow();
    expect(() =>
      parseLintResult(
        `{"issues":[{"level":"warning","message":"m","statement":"nope"}]}`,
        "public.f",
      ),
    ).toThrow();
  });

  it("throws on a present non-string top-level function field, accepts string/absent", () => {
    // `function` is a string field; a non-string value throws before it is
    // overridden with <schema>.<name>.
    expect(() => parseLintResult(`{"function":123,"issues":[]}`, "public.f")).toThrow();
    expect(parseLintResult(`{"function":"x","issues":[]}`, "public.f")).toEqual({
      function: "public.f",
      issues: [],
    });
    expect(parseLintResult(`{"issues":[]}`, "public.f")).toEqual({
      function: "public.f",
      issues: [],
    });
  });

  it("tolerates Go-accepted shapes (null, missing issues, unknown fields)", () => {
    // The result stays at zero on a top-level null, and unknown fields stay tolerated.
    expect(parseLintResult("null", "public.f")).toEqual({ function: "public.f", issues: [] });
    expect(parseLintResult("{}", "public.f")).toEqual({ function: "public.f", issues: [] });
    expect(parseLintResult(`{"issues":null}`, "public.f")).toEqual({
      function: "public.f",
      issues: [],
    });
    expect(parseLintResult(`{"unknown":1,"issues":[]}`, "public.f")).toEqual({
      function: "public.f",
      issues: [],
    });
  });

  it("decodes a null array element to the zero-value Issue{} (Go encoding/json behavior)", () => {
    // A null element in the issues array decodes as the zero-value issue
    // (level: "", message: ""). It is included in the slice and later
    // filtered out by filterLintResult since toEnum("") returns -1.
    const result = parseLintResult(`{"issues":[null]}`, "public.f");
    expect(result.issues).toEqual([{ level: "", message: "" }]);
  });

  it("null element alongside real issues normalizes to zero-value without throwing", () => {
    const result = parseLintResult(
      `{"issues":[null,{"level":"error","message":"boom"}]}`,
      "public.f",
    );
    expect(result.issues).toEqual([
      { level: "", message: "" },
      { level: "error", message: "boom" },
    ]);
  });
});

describe("filterLintResult", () => {
  const result: ReadonlyArray<LintResult> = [
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
    expect(filterLintResult(result, LINT_LEVEL_ENUM.toEnum("warning"))).toEqual(result);
  });

  it("drops warning-only results at the error threshold", () => {
    expect(filterLintResult(result, LINT_LEVEL_ENUM.toEnum("error"))).toEqual([
      { function: "public.f1", issues: [{ level: "error", message: "test 1b" }] },
    ]);
  });
});

describe("encodeLintResults (Go printResultJSON byte parity)", () => {
  it("emits struct-order keys, drops empty omitempty fields, trailing newline", () => {
    const results: ReadonlyArray<LintResult> = [
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
    expect(encodeLintResults(results)).toBe(
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
