import { describe, expect, it } from "vitest";

import {
  encodeGoJsonCompact,
  encodeGoJsonIndented,
  escapeGoJsonString,
  legacyGoJsonKindName,
} from "./legacy-go-json.ts";

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

describe("encodeGoJsonCompact", () => {
  it("matches Go's json.Marshal compact shape with HTML escaping", () => {
    expect(encodeGoJsonCompact({ metadata_xml: "<xml>&stuff</xml>", type: "saml" })).toBe(
      '{"metadata_xml":"\\u003cxml\\u003e\\u0026stuff\\u003c/xml\\u003e","type":"saml"}',
    );
  });

  it("keeps insertion order, compact separators, and no trailing newline", () => {
    expect(encodeGoJsonCompact({ b: [1, 2], a: { c: true } })).toBe('{"b":[1,2],"a":{"c":true}}');
    expect(encodeGoJsonCompact([])).toBe("[]");
    expect(encodeGoJsonCompact(null)).toBe("null");
  });

  // `JSON.stringify(-0)` collapses to `"0"` (ECMA-262 prints no sign for negative
  // zero), but `encoding/json` marshals a `float64` negative zero as `-0` —
  // reachable through `gen bearer-jwt --payload`'s `json.Unmarshal` into a real Go
  // map. Verified against the real binary (CLI-1961 Codex review finding): the
  // compiled Go CLI's signed token payload for `--payload '{"extra":-0}'` literally
  // contains `"extra":-0`.
  it("preserves negative zero's sign, unlike plain JSON.stringify", () => {
    expect(encodeGoJsonCompact({ extra: -0 })).toBe('{"extra":-0}');
    expect(encodeGoJsonCompact({ extra: Number("-1e-10000") })).toBe('{"extra":-0}');
    expect(encodeGoJsonCompact({ extra: 0 })).toBe('{"extra":0}');
  });

  it("iterates a Map in true insertion order, unlike a plain object with integer-like keys", () => {
    // A plain object always reorders integer-like string keys ("2", "10") into ascending
    // NUMERIC order on enumeration, regardless of insertion order — a `Map` does not, which
    // is exactly why `legacy-go-output.encoders.ts`'s `sortKeysDeep` builds one to carry a
    // lexicographic sort through to this walker intact (CLI-1961 Codex review finding).
    const map = new Map<string, unknown>([
      ["10", "a"],
      ["2", "b"],
    ]);
    expect(encodeGoJsonCompact(map)).toBe('{"10":"a","2":"b"}');
  });
});

describe("legacyGoJsonKindName", () => {
  it("names every JSON-representable kind, including the generic fallback", () => {
    expect(legacyGoJsonKindName([])).toBe("array");
    expect(legacyGoJsonKindName(1)).toBe("number");
    expect(legacyGoJsonKindName("s")).toBe("string");
    expect(legacyGoJsonKindName(true)).toBe("bool");
    // Never reachable from real JSON.parse output (every call site already excludes
    // null/array/object before calling this) — exercised directly for completeness.
    expect(legacyGoJsonKindName(undefined)).toBe("value");
  });
});
