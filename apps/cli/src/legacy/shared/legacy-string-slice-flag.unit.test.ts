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

  // --- malformed inputs: must THROW ---

  it("throws on an unterminated quoted field", () => {
    // `"tenant` — opening quote but no closing quote
    expect(() => legacyParseStringSliceFlag(['"tenant'])).toThrow(LegacyStringSliceFlagParseError);
    expect(() => legacyParseStringSliceFlag(['"tenant'])).toThrow(
      /extraneous or missing " in quoted-field/,
    );
  });

  it("throws on extra bytes after a closing quote", () => {
    // `"a"b` — closing quote followed by a non-comma character
    expect(() => legacyParseStringSliceFlag(['"a"b'])).toThrow(LegacyStringSliceFlagParseError);
    expect(() => legacyParseStringSliceFlag(['"a"b'])).toThrow(
      /extraneous or missing " in quoted-field/,
    );
  });

  it("throws on a bare quote inside an unquoted field", () => {
    // `a"b` — bare " in a field that did not start with a quote
    expect(() => legacyParseStringSliceFlag(['a"b'])).toThrow(LegacyStringSliceFlagParseError);
    expect(() => legacyParseStringSliceFlag(['a"b'])).toThrow(/bare " in non-quoted-field/);
  });

  it("throws on the first malformed value in a multi-value list", () => {
    // The valid "public" comes before the malformed one; the error is still thrown
    expect(() => legacyParseStringSliceFlag(["public", '"broken'])).toThrow(
      LegacyStringSliceFlagParseError,
    );
  });
});
