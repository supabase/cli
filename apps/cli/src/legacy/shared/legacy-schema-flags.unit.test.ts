import { describe, expect, it } from "vitest";
import {
  legacyParseSchemaFlags,
  LegacySchemaFlagParseError,
  legacySchemaToCsvField,
} from "./legacy-schema-flags.ts";

describe("legacyParseSchemaFlags (pflag StringSlice CSV parity)", () => {
  it("splits unquoted comma-separated values", () => {
    expect(legacyParseSchemaFlags(["public,private"])).toEqual(["public", "private"]);
  });

  it("keeps a quoted value with embedded comma as a single element", () => {
    // pflag TestSSWithComma: `"tenant,one"` → one element "tenant,one"
    expect(legacyParseSchemaFlags(['"tenant,one"'])).toEqual(["tenant,one"]);
  });

  it("single value with no comma", () => {
    expect(legacyParseSchemaFlags(["public"])).toEqual(["public"]);
  });

  it("accumulates repeated flags", () => {
    expect(legacyParseSchemaFlags(["public", "private"])).toEqual(["public", "private"]);
  });

  it("accumulates repeated flags mixed with csv", () => {
    expect(legacyParseSchemaFlags(["public,private", "staging"])).toEqual([
      "public",
      "private",
      "staging",
    ]);
  });

  it("unescapes doubled double-quote inside quoted field", () => {
    // Go csv: `"a""b"` → field is `a"b`
    expect(legacyParseSchemaFlags(['"a""b"'])).toEqual(['a"b']);
  });

  it("empty input returns empty array", () => {
    expect(legacyParseSchemaFlags([])).toEqual([]);
  });

  it("preserves whitespace (Go does not trim)", () => {
    // Go csv passes raw field values; pflag does not trim
    expect(legacyParseSchemaFlags([" public , private "])).toEqual([" public ", " private "]);
  });

  // --- malformed inputs: must THROW ---

  it("throws on an unterminated quoted field", () => {
    // `"tenant` — opening quote but no closing quote
    expect(() => legacyParseSchemaFlags(['"tenant'])).toThrow(LegacySchemaFlagParseError);
    expect(() => legacyParseSchemaFlags(['"tenant'])).toThrow(
      /extraneous or missing " in quoted-field/,
    );
  });

  it("throws on extra bytes after a closing quote", () => {
    // `"a"b` — closing quote followed by a non-comma character
    expect(() => legacyParseSchemaFlags(['"a"b'])).toThrow(LegacySchemaFlagParseError);
    expect(() => legacyParseSchemaFlags(['"a"b'])).toThrow(
      /extraneous or missing " in quoted-field/,
    );
  });

  it("throws on a bare quote inside an unquoted field", () => {
    // `a"b` — bare " in a field that did not start with a quote
    expect(() => legacyParseSchemaFlags(['a"b'])).toThrow(LegacySchemaFlagParseError);
    expect(() => legacyParseSchemaFlags(['a"b'])).toThrow(/bare " in non-quoted-field/);
  });

  it("throws on the first malformed value in a multi-value list", () => {
    // The valid "public" comes before the malformed one; the error is still thrown
    expect(() => legacyParseSchemaFlags(["public", '"broken'])).toThrow(LegacySchemaFlagParseError);
  });
});

describe("legacySchemaToCsvField (inverse — re-encode one value as a CSV field)", () => {
  it("leaves a plain value unquoted", () => {
    expect(legacySchemaToCsvField("public")).toBe("public");
  });

  it("leaves the empty string unquoted (Go csv.Writer)", () => {
    expect(legacySchemaToCsvField("")).toBe("");
  });

  it("quotes a value containing a comma", () => {
    expect(legacySchemaToCsvField("tenant,one")).toBe('"tenant,one"');
  });

  it("quotes and doubles an embedded quote", () => {
    expect(legacySchemaToCsvField('a"b')).toBe('"a""b"');
  });

  it("quotes a value with a leading space", () => {
    expect(legacySchemaToCsvField(" leading")).toBe('" leading"');
  });

  it("round-trips through the parser for awkward values", () => {
    // parse(encode(x)) === [x] for the cases a delegated child would otherwise split.
    for (const value of ["public", "tenant,one", 'a"b', " leading", "a,b,c", ""]) {
      expect(legacyParseSchemaFlags([legacySchemaToCsvField(value)])).toEqual(
        value === "" ? [] : [value],
      );
    }
  });
});
