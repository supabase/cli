import { describe, expect, it } from "vitest";

import { encodeGoJsonIndented, escapeGoJsonString } from "./legacy-go-json.ts";

describe("escapeGoJsonString", () => {
  it("escapes quotes and backslashes like Go", () => {
    expect(escapeGoJsonString(`a"b\\c`)).toBe('"a\\"b\\\\c"');
  });

  it("HTML-escapes <, > and & (Go's default escapeHTML)", () => {
    expect(escapeGoJsonString("<a> & <b>")).toBe('"\\u003ca\\u003e \\u0026 \\u003cb\\u003e"');
  });

  it("uses short escapes for tab/newline/carriage-return", () => {
    expect(escapeGoJsonString("a\tb\nc\rd")).toBe('"a\\tb\\nc\\rd"');
  });

  it("uses \\u00xx for other control characters (no \\b / \\f shorthand)", () => {
    expect(escapeGoJsonString("\b\f")).toBe('"\\u0008\\u000c"');
  });

  it("escapes U+2028 and U+2029", () => {
    expect(escapeGoJsonString("  ")).toBe('"\\u2028\\u2029"');
  });
});

describe("encodeGoJsonIndented", () => {
  it("preserves object key insertion order (not alphabetical)", () => {
    expect(encodeGoJsonIndented({ level: "error", message: "boom" })).toBe(
      `{\n  "level": "error",\n  "message": "boom"\n}\n`,
    );
  });

  it("renders nested arrays of objects with 2-space indent and a trailing newline", () => {
    const value = [{ function: "public.f1", issues: [{ level: "error", message: "test 1b" }] }];
    expect(encodeGoJsonIndented(value)).toBe(
      [
        "[",
        "  {",
        '    "function": "public.f1",',
        '    "issues": [',
        "      {",
        '        "level": "error",',
        '        "message": "test 1b"',
        "      }",
        "    ]",
        "  }",
        "]",
        "",
      ].join("\n"),
    );
  });

  it("renders empty arrays and objects compactly", () => {
    expect(encodeGoJsonIndented([])).toBe("[]\n");
    expect(encodeGoJsonIndented({})).toBe("{}\n");
    expect(encodeGoJsonIndented({ issues: [] })).toBe(`{\n  "issues": []\n}\n`);
  });
});
