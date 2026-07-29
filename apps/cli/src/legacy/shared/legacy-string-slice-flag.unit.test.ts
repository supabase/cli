import { describe, expect, it } from "vitest";
import {
  legacyParseStringSliceFlag,
  LegacyStringSliceFlagParseError,
} from "./legacy-string-slice-flag.ts";

describe("legacyParseStringSliceFlag (pflag StringSlice CSV parity)", () => {
  it("splits unquoted comma-separated values", () => {
    expect(legacyParseStringSliceFlag(["public,private"])).toEqual(["public", "private"]);
  });

  it("keeps a quoted value with embedded comma as a single element", () => {
    // pflag TestSSWithComma: `"tenant,one"` → one element "tenant,one"
    expect(legacyParseStringSliceFlag(['"tenant,one"'])).toEqual(["tenant,one"]);
  });

  it("single value with no comma", () => {
    expect(legacyParseStringSliceFlag(["public"])).toEqual(["public"]);
  });

  it("accumulates repeated flags", () => {
    expect(legacyParseStringSliceFlag(["public", "private"])).toEqual(["public", "private"]);
  });

  it("accumulates repeated flags mixed with csv", () => {
    expect(legacyParseStringSliceFlag(["public,private", "staging"])).toEqual([
      "public",
      "private",
      "staging",
    ]);
  });

  it("unescapes doubled double-quote inside quoted field", () => {
    // Go csv: `"a""b"` → field is `a"b`
    expect(legacyParseStringSliceFlag(['"a""b"'])).toEqual(['a"b']);
  });

  it("empty input returns empty array", () => {
    expect(legacyParseStringSliceFlag([])).toEqual([]);
  });

  it("preserves whitespace (Go does not trim)", () => {
    // Go csv passes raw field values; pflag does not trim
    expect(legacyParseStringSliceFlag([" public , private "])).toEqual([" public ", " private "]);
  });

  // --- malformed inputs: must THROW with Go's exact message ---
  //
  // Columns are 1-based BYTE offsets, matching Go `encoding/csv`'s
  // `ParseError.Column`. Every vector below was verified against the real Go
  // CLI (`apps/cli-go`, pflag v1.0.10 → encoding/csv, Go 1.26).

  it("throws on an unterminated quoted field (column = byte length + 1, Go hits EOF)", () => {
    // `"tenant` — opening quote but no closing quote; 7 bytes → column 8
    expect(() => legacyParseStringSliceFlag(['"tenant'])).toThrow(LegacyStringSliceFlagParseError);
    expect(() => legacyParseStringSliceFlag(['"tenant'])).toThrow(
      'parse error on line 1, column 8: extraneous or missing " in quoted-field',
    );
    // `"1.2.3.4` — 8 bytes → column 9
    expect(() => legacyParseStringSliceFlag(['"1.2.3.4'])).toThrow(
      'parse error on line 1, column 9: extraneous or missing " in quoted-field',
    );
    // `a,"b` — the unterminated quote opens the SECOND field, but the column
    // still counts from the start of the whole value; 4 bytes → column 5
    expect(() => legacyParseStringSliceFlag(['a,"b'])).toThrow(
      'parse error on line 1, column 5: extraneous or missing " in quoted-field',
    );
  });

  it("throws on extra bytes after a closing quote (column = byte position of the closing quote)", () => {
    // `"a"b` — closing quote at byte 3
    expect(() => legacyParseStringSliceFlag(['"a"b'])).toThrow(LegacyStringSliceFlagParseError);
    expect(() => legacyParseStringSliceFlag(['"a"b'])).toThrow(
      'parse error on line 1, column 3: extraneous or missing " in quoted-field',
    );
    // `aa,"b"x` — closing quote of the second field at byte 6
    expect(() => legacyParseStringSliceFlag(['aa,"b"x'])).toThrow(
      'parse error on line 1, column 6: extraneous or missing " in quoted-field',
    );
  });

  it("throws on a bare quote inside an unquoted field (column = byte position of the quote)", () => {
    // `a"b` — bare " at byte 2
    expect(() => legacyParseStringSliceFlag(['a"b'])).toThrow(LegacyStringSliceFlagParseError);
    expect(() => legacyParseStringSliceFlag(['a"b'])).toThrow(
      'parse error on line 1, column 2: bare " in non-quoted-field',
    );
    // `1.2.3.4,5"6` — bare " in the second field, at byte 10 of the value
    expect(() => legacyParseStringSliceFlag(['1.2.3.4,5"6'])).toThrow(
      'parse error on line 1, column 10: bare " in non-quoted-field',
    );
  });

  it("counts columns in bytes, not code points (Go csv tracks byte offsets)", () => {
    // `é"x` — é is 2 UTF-8 bytes, so the bare quote sits at byte 3
    expect(() => legacyParseStringSliceFlag(['é"x'])).toThrow(
      'parse error on line 1, column 3: bare " in non-quoted-field',
    );
    // `"é` — 3 bytes total, EOF in a quoted field → column 4
    expect(() => legacyParseStringSliceFlag(['"é'])).toThrow(
      'parse error on line 1, column 4: extraneous or missing " in quoted-field',
    );
  });

  it("carries the offending occurrence and column on the error for pflag framing", () => {
    try {
      legacyParseStringSliceFlag(["public", '"broken']);
      expect.unreachable("expected legacyParseStringSliceFlag to throw");
    } catch (err) {
      if (!(err instanceof LegacyStringSliceFlagParseError)) throw err;
      // pflag wraps the csv error PER OCCURRENCE (`flag.go` `Set`), quoting
      // only the malformed value — not the accumulated list.
      expect(err.value).toBe('"broken');
      expect(err.column).toBe(8);
    }
  });

  it("throws on the first malformed value in a multi-value list", () => {
    // The valid "public" comes before the malformed one; the error is still thrown
    expect(() => legacyParseStringSliceFlag(["public", '"broken'])).toThrow(
      LegacyStringSliceFlagParseError,
    );
  });
});
