import { describe, expect, it } from "vitest";

import {
  encodeLintResults,
  filterLintResult,
  LEGACY_LINT_LEVEL_ENUM,
  type LegacyLintResult,
  parseLintResult,
} from "./lint.format.ts";

describe("LEGACY_LINT_LEVEL_ENUM (Go toEnum, prefix match)", () => {
  it("maps warning/error and the plpgsql_check 'warning extra' level", () => {
    expect(LEGACY_LINT_LEVEL_ENUM.toEnum("warning")).toBe(0);
    expect(LEGACY_LINT_LEVEL_ENUM.toEnum("error")).toBe(1);
    expect(LEGACY_LINT_LEVEL_ENUM.toEnum("warning extra")).toBe(0);
    expect(LEGACY_LINT_LEVEL_ENUM.toEnum("none")).toBe(-1);
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
});

describe("filterLintResult", () => {
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
    expect(filterLintResult(result, LEGACY_LINT_LEVEL_ENUM.toEnum("warning"))).toEqual(result);
  });

  it("drops warning-only results at the error threshold", () => {
    expect(filterLintResult(result, LEGACY_LINT_LEVEL_ENUM.toEnum("error"))).toEqual([
      { function: "public.f1", issues: [{ level: "error", message: "test 1b" }] },
    ]);
  });
});

describe("encodeLintResults (Go printResultJSON byte parity)", () => {
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
