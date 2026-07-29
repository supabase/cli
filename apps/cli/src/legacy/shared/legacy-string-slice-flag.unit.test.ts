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

  it("carries the offending occurrence and Go's exact message on the error for pflag framing", () => {
    try {
      legacyParseStringSliceFlag(["public", '"broken']);
      expect.unreachable("expected legacyParseStringSliceFlag to throw");
    } catch (err) {
      if (!(err instanceof LegacyStringSliceFlagParseError)) throw err;
      // pflag wraps the csv error PER OCCURRENCE (`flag.go` `Set`), quoting
      // only the malformed value — not the accumulated list.
      expect(err.value).toBe('"broken');
      expect(err.message).toBe(
        'parse error on line 1, column 8: extraneous or missing " in quoted-field',
      );
    }
  });

  it("throws on the first malformed value in a multi-value list", () => {
    // The valid "public" comes before the malformed one; the error is still thrown
    expect(() => legacyParseStringSliceFlag(["public", '"broken'])).toThrow(
      LegacyStringSliceFlagParseError,
    );
  });

  // --- multiline values: Go tracks PHYSICAL lines (encoding/csv readLine) ---
  //
  // pflag calls `csv.Reader.Read()` exactly once, so only the FIRST CSV
  // record survives, blank lines before it are skipped, `\r\n` is normalized
  // to `\n`, and parse errors report per-line byte columns with a
  // `record on line N; ` prefix when the record starts before the error line
  // (`csv.ParseError.Error()`). Every vector below was verified against the
  // real Go CLI (`apps/cli-go`, pflag v1.0.10 → encoding/csv, Go 1.26).

  it("keeps only the first record when an unquoted newline ends it (pflag reads ONE record)", () => {
    expect(legacyParseStringSliceFlag(["1.2.3.4\n5.6.7.8"])).toEqual(["1.2.3.4"]);
    // …even when the dropped remainder would itself be malformed CSV — Go
    // never parses past the first record, so no error is raised.
    expect(legacyParseStringSliceFlag(['1.2.3.4\na"b'])).toEqual(["1.2.3.4"]);
    expect(legacyParseStringSliceFlag(["a,b\nc"])).toEqual(["a", "b"]);
    expect(legacyParseStringSliceFlag(['"a"\njunk'])).toEqual(["a"]);
    expect(legacyParseStringSliceFlag(["a\n"])).toEqual(["a"]);
    expect(legacyParseStringSliceFlag(["a\r\nb"])).toEqual(["a"]);
  });

  it("skips blank lines before the record and errors with pflag's EOF for blank-only values", () => {
    expect(legacyParseStringSliceFlag(["\n\na"])).toEqual(["a"]);
    expect(legacyParseStringSliceFlag(["\r\na"])).toEqual(["a"]);
    // A value of only blank lines: csv.Read returns io.EOF, which pflag
    // surfaces verbatim (`invalid argument "\n" for "--x" flag: EOF`).
    expect(() => legacyParseStringSliceFlag(["\n"])).toThrow(LegacyStringSliceFlagParseError);
    expect(() => legacyParseStringSliceFlag(["\n"])).toThrow(/^EOF$/);
  });

  it("normalizes \\r\\n to \\n inside quoted fields, keeps lone \\r, drops trailing \\r at EOF", () => {
    expect(legacyParseStringSliceFlag(['"a\nb"'])).toEqual(["a\nb"]); // quoted newline is data
    expect(legacyParseStringSliceFlag(['"a\r\nb"'])).toEqual(["a\nb"]); // \r\n → \n
    expect(legacyParseStringSliceFlag(['"a\rb"'])).toEqual(["a\rb"]); // lone \r kept
    expect(legacyParseStringSliceFlag(['"x\r\n\ry"'])).toEqual(["x\n\ry"]);
    expect(legacyParseStringSliceFlag(["a\rb"])).toEqual(["a\rb"]);
    expect(legacyParseStringSliceFlag(["a\r"])).toEqual(["a"]); // trailing \r before EOF dropped
    expect(legacyParseStringSliceFlag(["a\r,b"])).toEqual(["a\r", "b"]);
  });

  it("reports the physical error line, with the record-start prefix when they differ", () => {
    // Unterminated quote spanning lines: EOF on line 2, column 5 (one past
    // `junk`), record started on line 1.
    expect(() => legacyParseStringSliceFlag(['"1.2.3.4\njunk'])).toThrow(
      'record on line 1; parse error on line 2, column 5: extraneous or missing " in quoted-field',
    );
    // Blank lines INSIDE the quoted field still count as physical lines.
    expect(() => legacyParseStringSliceFlag(['"1.2.3.4\n\njunk'])).toThrow(
      'record on line 1; parse error on line 3, column 5: extraneous or missing " in quoted-field',
    );
    // Extraneous byte after the closing quote on line 2: column of the quote.
    expect(() => legacyParseStringSliceFlag(['"1.2.3.4\njunk"extra'])).toThrow(
      'record on line 1; parse error on line 2, column 5: extraneous or missing " in quoted-field',
    );
    // Second field's quote unterminated across lines.
    expect(() => legacyParseStringSliceFlag(['a,"b\nc'])).toThrow(
      'record on line 1; parse error on line 2, column 2: extraneous or missing " in quoted-field',
    );
    // Error on line 1 keeps the plain format (StartLine == Line)…
    expect(() => legacyParseStringSliceFlag(['a"b\nc'])).toThrow(
      'parse error on line 1, column 2: bare " in non-quoted-field',
    );
    // …as does a record that STARTS on line 2 (leading blank line skipped).
    expect(() => legacyParseStringSliceFlag(['\n"bad'])).toThrow(
      'parse error on line 2, column 5: extraneous or missing " in quoted-field',
    );
    expect(() => legacyParseStringSliceFlag(['\r\n"x'])).toThrow(
      'parse error on line 2, column 3: extraneous or missing " in quoted-field',
    );
  });

  it("counts multiline columns in bytes within the error's own line", () => {
    // Line 2 is `éé"x`: two 2-byte é's put the closing quote at byte 5.
    expect(() => legacyParseStringSliceFlag(['"é\néé"x'])).toThrow(
      'record on line 1; parse error on line 2, column 5: extraneous or missing " in quoted-field',
    );
  });

  it("EOF-column edge cases around \\r and \\n (readLine drops/normalizes before counting)", () => {
    // `"a\r` — trailing \r before EOF is dropped, so EOF is at column 3.
    expect(() => legacyParseStringSliceFlag(['"a\r'])).toThrow(
      'parse error on line 1, column 3: extraneous or missing " in quoted-field',
    );
    // `"a\n` — the newline is quoted-field DATA (1 byte after normalization),
    // and the error line stays 1 because no further line was read.
    expect(() => legacyParseStringSliceFlag(['"a\n'])).toThrow(
      'parse error on line 1, column 4: extraneous or missing " in quoted-field',
    );
    expect(() => legacyParseStringSliceFlag(['"a\r\n'])).toThrow(
      'parse error on line 1, column 4: extraneous or missing " in quoted-field',
    );
  });
});
