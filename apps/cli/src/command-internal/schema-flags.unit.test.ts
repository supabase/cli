import { describe, expect, it } from "vitest";
import { parseSchemaFlags, SchemaFlagParseError, schemaToCsvField } from "./schema-flags.ts";

describe("parseSchemaFlags (pflag StringSlice CSV parity)", () => {
  it("splits unquoted comma-separated values", () => {
    expect(parseSchemaFlags(["public,private"])).toEqual(["public", "private"]);
  });

  it("keeps a quoted value with embedded comma as a single element", () => {
    // pflag TestSSWithComma: `"tenant,one"` → one element "tenant,one"
    expect(parseSchemaFlags(['"tenant,one"'])).toEqual(["tenant,one"]);
  });

  it("single value with no comma", () => {
    expect(parseSchemaFlags(["public"])).toEqual(["public"]);
  });

  it("accumulates repeated flags", () => {
    expect(parseSchemaFlags(["public", "private"])).toEqual(["public", "private"]);
  });

  it("accumulates repeated flags mixed with csv", () => {
    expect(parseSchemaFlags(["public,private", "staging"])).toEqual([
      "public",
      "private",
      "staging",
    ]);
  });

  it("unescapes doubled double-quote inside quoted field", () => {
    // Go csv: `"a""b"` → field is `a"b`
    expect(parseSchemaFlags(['"a""b"'])).toEqual(['a"b']);
  });

  it("empty input returns empty array", () => {
    expect(parseSchemaFlags([])).toEqual([]);
  });

  it("preserves whitespace (Go does not trim)", () => {
    // Go csv passes raw field values; pflag does not trim
    expect(parseSchemaFlags([" public , private "])).toEqual([" public ", " private "]);
  });

  // --- malformed inputs: must THROW ---

  it("throws on an unterminated quoted field", () => {
    // `"tenant` — opening quote but no closing quote
    expect(() => parseSchemaFlags(['"tenant'])).toThrow(SchemaFlagParseError);
    expect(() => parseSchemaFlags(['"tenant'])).toThrow(/extraneous or missing " in quoted-field/);
  });

  it("throws on extra bytes after a closing quote", () => {
    // `"a"b` — closing quote followed by a non-comma character
    expect(() => parseSchemaFlags(['"a"b'])).toThrow(SchemaFlagParseError);
    expect(() => parseSchemaFlags(['"a"b'])).toThrow(/extraneous or missing " in quoted-field/);
  });

  it("throws on a bare quote inside an unquoted field", () => {
    // `a"b` — bare " in a field that did not start with a quote
    expect(() => parseSchemaFlags(['a"b'])).toThrow(SchemaFlagParseError);
    expect(() => parseSchemaFlags(['a"b'])).toThrow(/bare " in non-quoted-field/);
  });

  it("throws on the first malformed value in a multi-value list", () => {
    // The valid "public" comes before the malformed one; the error is still thrown
    expect(() => parseSchemaFlags(["public", '"broken'])).toThrow(SchemaFlagParseError);
  });
});

describe("schemaToCsvField (inverse — re-encode one value as a CSV field)", () => {
  it("leaves a plain value unquoted", () => {
    expect(schemaToCsvField("public")).toBe("public");
  });

  it("leaves the empty string unquoted (Go csv.Writer)", () => {
    expect(schemaToCsvField("")).toBe("");
  });

  it("quotes a value containing a comma", () => {
    expect(schemaToCsvField("tenant,one")).toBe('"tenant,one"');
  });

  it("quotes and doubles an embedded quote", () => {
    expect(schemaToCsvField('a"b')).toBe('"a""b"');
  });

  it("quotes a value with a leading space", () => {
    expect(schemaToCsvField(" leading")).toBe('" leading"');
  });

  it("round-trips through the parser for awkward values", () => {
    // parse(encode(x)) === [x] for the cases a delegated child would otherwise split.
    for (const value of ["public", "tenant,one", 'a"b', " leading", "a,b,c", ""]) {
      expect(parseSchemaFlags([schemaToCsvField(value)])).toEqual(value === "" ? [] : [value]);
    }
  });
});
