import { describe, expect, it } from "vitest";

import {
  encodeHtmlSafeJsonCompact,
  encodeHtmlSafeJsonIndented,
  escapeHtmlSafeJsonString,
  jsonKindName,
} from "./html-safe-json.ts";

describe("escapeHtmlSafeJsonString", () => {
  it("escapes quotes and backslashes", () => {
    expect(escapeHtmlSafeJsonString(`a"b\\c`)).toBe('"a\\"b\\\\c"');
  });

  it("HTML-escapes <, > and &", () => {
    expect(escapeHtmlSafeJsonString("<a> & <b>")).toBe('"\\u003ca\\u003e \\u0026 \\u003cb\\u003e"');
  });

  it("uses short escapes for tab/newline/carriage-return", () => {
    expect(escapeHtmlSafeJsonString("a\tb\nc\rd")).toBe('"a\\tb\\nc\\rd"');
  });

  it("uses \\u00xx for other control characters (no \\b / \\f shorthand)", () => {
    expect(escapeHtmlSafeJsonString("\b\f")).toBe('"\\u0008\\u000c"');
  });

  it("escapes U+2028 and U+2029", () => {
    expect(escapeHtmlSafeJsonString("  ")).toBe('"\\u2028\\u2029"');
  });
});

describe("encodeHtmlSafeJsonIndented", () => {
  it("preserves object key insertion order (not alphabetical)", () => {
    expect(encodeHtmlSafeJsonIndented({ level: "error", message: "boom" })).toBe(
      `{\n  "level": "error",\n  "message": "boom"\n}\n`,
    );
  });

  it("renders nested arrays of objects with 2-space indent and a trailing newline", () => {
    const value = [{ function: "public.f1", issues: [{ level: "error", message: "test 1b" }] }];
    expect(encodeHtmlSafeJsonIndented(value)).toBe(
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
    expect(encodeHtmlSafeJsonIndented([])).toBe("[]\n");
    expect(encodeHtmlSafeJsonIndented({})).toBe("{}\n");
    expect(encodeHtmlSafeJsonIndented({ issues: [] })).toBe(`{\n  "issues": []\n}\n`);
  });
});

describe("encodeHtmlSafeJsonCompact", () => {
  it("emits the compact shape with HTML escaping", () => {
    expect(encodeHtmlSafeJsonCompact({ metadata_xml: "<xml>&stuff</xml>", type: "saml" })).toBe(
      '{"metadata_xml":"\\u003cxml\\u003e\\u0026stuff\\u003c/xml\\u003e","type":"saml"}',
    );
  });

  it("keeps insertion order, compact separators, and no trailing newline", () => {
    expect(encodeHtmlSafeJsonCompact({ b: [1, 2], a: { c: true } })).toBe(
      '{"b":[1,2],"a":{"c":true}}',
    );
    expect(encodeHtmlSafeJsonCompact([])).toBe("[]");
    expect(encodeHtmlSafeJsonCompact(null)).toBe("null");
  });

  it("preserves negative zero's sign, unlike plain JSON.stringify", () => {
    expect(encodeHtmlSafeJsonCompact({ extra: -0 })).toBe('{"extra":-0}');
    expect(encodeHtmlSafeJsonCompact({ extra: Number("-1e-10000") })).toBe('{"extra":-0}');
    expect(encodeHtmlSafeJsonCompact({ extra: 0 })).toBe('{"extra":0}');
  });

  it("iterates a Map in true insertion order, unlike a plain object with integer-like keys", () => {
    const map = new Map<string, unknown>([
      ["10", "a"],
      ["2", "b"],
    ]);
    expect(encodeHtmlSafeJsonCompact(map)).toBe('{"10":"a","2":"b"}');
  });
});

describe("jsonKindName", () => {
  it("names every JSON-representable kind, including the generic fallback", () => {
    expect(jsonKindName([])).toBe("array");
    expect(jsonKindName(1)).toBe("number");
    expect(jsonKindName("s")).toBe("string");
    expect(jsonKindName(true)).toBe("boolean");
    expect(jsonKindName(undefined)).toBe("value");
  });
});
