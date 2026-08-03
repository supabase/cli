/**
 * Parses a pflag `StringSliceVar` flag: CSV-splits each occurrence via
 * `encoding/csv` and accumulates across repeats, matching `readAsCSV` in
 * `github.com/spf13/pflag/string_slice.go`'s `stringSliceValue.Set`. A naive
 * `.split(",")` diverges on quoted/embedded commas (`'"a,b",c'`). Effect V4
 * CLI has no CSV/list primitive, so every Go `StringSliceVar` flag ported to
 * the legacy shell needs this (e.g. `--domains`, `--config`).
 *
 * Whitespace is NOT trimmed and empty fields are NOT dropped: Go's csv.Reader
 * returns raw field values; pflag appends them directly to the slice.
 */
import { Flag } from "effect/unstable/cli";

const QUOTE = 0x22; // "
const COMMA = 0x2c; // ,
const LF = 0x0a; // \n
const CR = 0x0d; // \r

const EMPTY = new Uint8Array(0);

/** Go `encoding/csv` `lengthNL`: number of bytes for the trailing `\n`. */
const lengthNL = (b: Uint8Array): number => (b.length > 0 && b[b.length - 1] === LF ? 1 : 0);

/**
 * Thrown by `legacyParseStringSliceFlag` when a value is not valid CSV.
 *
 * `message` reproduces Go's error string byte-for-byte:
 *  - `csv.ParseError.Error()` for malformed CSV (with the
 *    `record on line %d; ` prefix when the record starts on an earlier
 *    physical line than the error — `encoding/csv/reader.go`), or
 *  - the literal `EOF` when the value contains only blank lines (pflag's
 *    `readAsCSV` propagates `csv.Reader.Read`'s `io.EOF` unchanged).
 */
export class LegacyStringSliceFlagParseError extends Error {
  readonly value: string;
  private constructor(value: string, message: string) {
    super(message);
    this.name = "LegacyStringSliceFlagParseError";
    this.value = value;
  }
  /** Mirrors Go `csv.ParseError.Error()`. Line/column are 1-based; column is a byte offset within the physical line. */
  static parse(
    value: string,
    startLine: number,
    line: number,
    column: number,
    detail: string,
  ): LegacyStringSliceFlagParseError {
    const location = `parse error on line ${line}, column ${column}: ${detail}`;
    return new LegacyStringSliceFlagParseError(
      value,
      startLine !== line ? `record on line ${startLine}; ${location}` : location,
    );
  }
  /** Mirrors pflag propagating `io.EOF` (value is nothing but blank lines). */
  static eof(value: string): LegacyStringSliceFlagParseError {
    return new LegacyStringSliceFlagParseError(value, "EOF");
  }
}

/**
 * Parses one CSV record from `val`, a byte-faithful port of a single
 * `csv.Reader.Read()` with `NewReader` defaults (comma delimiter, no
 * comments, `LazyQuotes`/`TrimLeadingSpace` off) — the exact call pflag's
 * `readAsCSV` makes (`string_slice.go`). Ported from `readRecord`/`readLine`
 * in Go's `encoding/csv/reader.go`; verified against the real Go CLI,
 * including multiline and multibyte values.
 *
 * Semantics that only show up with `\r`/`\n` in the value (all Go-observed):
 *  - **Only the first record is read.** An unquoted newline ends the record
 *    and everything after it is silently dropped (`1.2.3.4\n5.6.7.8` →
 *    `["1.2.3.4"]`), because pflag calls `Read()` once.
 *  - Blank lines before the record are skipped; a value that is *only* blank
 *    lines makes `Read()` return `io.EOF`, which pflag surfaces as the error
 *    `EOF`.
 *  - `\r\n` is normalized to `\n` (so a quoted multiline field keeps `\n`,
 *    not `\r\n`); a lone `\r` is kept, except a trailing `\r` at EOF, which
 *    is dropped.
 *  - Parse errors report 1-based physical line numbers and 1-based **byte**
 *    columns within that line, with a `record on line N; ` prefix when the
 *    record started on an earlier line.
 *
 * **Throws `LegacyStringSliceFlagParseError`** on the malformed-CSV
 * conditions Go's `csv.Reader` rejects:
 *   - Quoted field with no closing quote (`"tenant`) → "extraneous or missing \" in quoted-field" (column = one past the last byte, Go hits EOF)
 *   - Extra non-comma bytes after a closing quote (`"a"b`) → "extraneous or missing \" in quoted-field" (column = the closing quote)
 *   - A bare `"` inside an unquoted field (`a"b`) → "bare \" in non-quoted-field" (column = the bare quote)
 */
function readAsCSVStrict(val: string): string[] {
  if (val === "") return [];
  // Go's csv.Reader works on bytes; ASCII delimiters (`"`, `,`, `\r`, `\n`)
  // never appear inside multibyte UTF-8 sequences, so byte scanning is exact
  // and columns come out in bytes for free.
  const input = new TextEncoder().encode(val);
  let offset = 0;
  let numLine = 0;

  // Port of `readLine`: returns one line INCLUDING its trailing `\n`, with
  // `\r\n` normalized to `\n` and a trailing `\r` before EOF dropped.
  // Returns null for `io.EOF` (nothing left to read).
  const readLine = (): Uint8Array | null => {
    if (offset >= input.length) return null;
    const nl = input.indexOf(LF, offset);
    let line: Uint8Array;
    if (nl >= 0) {
      line = input.subarray(offset, nl + 1);
      offset = nl + 1;
    } else {
      line = input.subarray(offset);
      offset = input.length;
      // For backwards compatibility, Go drops a trailing \r before EOF.
      if (line.length > 0 && line[line.length - 1] === CR) {
        line = line.subarray(0, line.length - 1);
      }
    }
    numLine++;
    // Normalize \r\n to \n on all input lines. Mutating is safe: `input` is
    // our own copy and these bytes are never re-read.
    const n = line.length;
    if (n >= 2 && line[n - 2] === CR && line[n - 1] === LF) {
      line[n - 2] = LF;
      line = line.subarray(0, n - 1);
    }
    return line;
  };

  // Read the record's first line, skipping past blank lines (Go's
  // `readRecord` empty-line loop). EOF here is pflag's `EOF` error.
  let line: Uint8Array;
  for (;;) {
    const next = readLine();
    if (next === null) throw LegacyStringSliceFlagParseError.eof(val);
    if (next.length === lengthNL(next)) continue; // Skip empty lines
    line = next;
    break;
  }

  // Port of `readRecord`'s parseField loop (LazyQuotes/TrimLeadingSpace off).
  const recLine = numLine; // Starting line for record
  const pos = { line: numLine, col: 1 };
  const recordBuffer: number[] = [];
  const fieldIndexes: number[] = [];
  const append = (bytes: Uint8Array): void => {
    for (const byte of bytes) recordBuffer.push(byte);
  };

  parseField: for (;;) {
    if (line.length === 0 || line[0] !== QUOTE) {
      // Non-quoted string field
      const comma = line.indexOf(COMMA);
      const field =
        comma >= 0 ? line.subarray(0, comma) : line.subarray(0, line.length - lengthNL(line));
      // Check to make sure a quote does not appear in the field.
      const bareQuote = field.indexOf(QUOTE);
      if (bareQuote >= 0) {
        throw LegacyStringSliceFlagParseError.parse(
          val,
          recLine,
          numLine,
          pos.col + bareQuote,
          `bare " in non-quoted-field`,
        );
      }
      append(field);
      fieldIndexes.push(recordBuffer.length);
      if (comma >= 0) {
        line = line.subarray(comma + 1);
        pos.col += comma + 1;
        continue parseField;
      }
      break parseField;
    } else {
      // Quoted string field
      line = line.subarray(1);
      pos.col += 1;
      for (;;) {
        const quote = line.indexOf(QUOTE);
        if (quote >= 0) {
          // Hit next quote.
          append(line.subarray(0, quote));
          line = line.subarray(quote + 1);
          pos.col += quote + 1;
          if (line.length > 0 && line[0] === QUOTE) {
            // `""` sequence (append quote).
            recordBuffer.push(QUOTE);
            line = line.subarray(1);
            pos.col += 1;
          } else if (line.length > 0 && line[0] === COMMA) {
            // `",` sequence (end of field).
            line = line.subarray(1);
            pos.col += 1;
            fieldIndexes.push(recordBuffer.length);
            continue parseField;
          } else if (lengthNL(line) === line.length) {
            // `"\n` sequence (end of line — pflag reads ONE record, so any
            // remaining input is dropped).
            fieldIndexes.push(recordBuffer.length);
            break parseField;
          } else {
            // `"*` sequence (invalid non-escaped quote). Go reports the byte
            // position of the closing quote itself (`pos.col - quoteLen`).
            throw LegacyStringSliceFlagParseError.parse(
              val,
              recLine,
              numLine,
              pos.col - 1,
              `extraneous or missing " in quoted-field`,
            );
          }
        } else if (line.length > 0) {
          // Hit end of line (copy all data so far, INCLUDING the `\n` — this
          // is how a quoted multiline field keeps its newline).
          append(line);
          pos.col += line.length;
          const next = readLine();
          if (next !== null && next.length > 0) {
            pos.line++;
            pos.col = 1;
          }
          line = next ?? EMPTY;
        } else {
          // Abrupt end of file: ran off the end without a closing quote, so
          // the reported column is one past the final byte of the last line.
          throw LegacyStringSliceFlagParseError.parse(
            val,
            recLine,
            pos.line,
            pos.col,
            `extraneous or missing " in quoted-field`,
          );
        }
      }
    }
  }

  // Create the field strings out of the accumulated record bytes.
  const record = new Uint8Array(recordBuffer);
  const decoder = new TextDecoder();
  const fields: string[] = [];
  let preIdx = 0;
  for (const idx of fieldIndexes) {
    fields.push(decoder.decode(record.subarray(preIdx, idx)));
    preIdx = idx;
  }
  return fields;
}

/**
 * CSV-parses and flattens all raw occurrences of a repeated pflag `StringSlice` flag.
 *
 * **Throws `LegacyStringSliceFlagParseError`** on the first malformed value, matching
 * Go's pflag parse-time behaviour where a bad value fails the command before it
 * runs (Go: `invalid argument "..." for "--<flag>" flag: parse error ...`).
 *
 * Valid behaviour:
 *   - `"tenant,one"` → `["tenant,one"]` (quoted comma stays one field)
 *   - `public,private` → `["public", "private"]`
 *   - no trimming, `""` escapes a literal quote inside a quoted field
 *   - empty string → no field; a value with an unquoted newline keeps only
 *     the first line's record (pflag reads a single CSV record)
 */
export function legacyParseStringSliceFlag(
  rawValues: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const values: string[] = [];
  for (const value of rawValues) {
    for (const field of readAsCSVStrict(value)) {
      values.push(field);
    }
  }
  return values;
}

/**
 * Builds a legacy flag that ports a pflag `StringSliceVar`/`StringSliceVarP`:
 * repeatable, CSV-split per occurrence, accumulated across repeats.
 *
 * On malformed CSV it fails at parse time — matching Go, where pflag's
 * `readAsCSV` error aborts cobra's `ParseFlags` before `PersistentPreRunE`
 * (so before the `--experimental` gate, telemetry, and the handler) — with
 * pflag's exact diagnostic: `invalid argument %q for %q flag: %v`
 * (pflag v1.0.10 `errors.go:116`, wrapped per occurrence in `flag.go:493`).
 * The full Go message is emitted as the failure's `expected` text so the
 * renderer's pflag passthrough (`formatInvalidValueMessage`) prints it
 * verbatim, byte-matching the Go CLI's stderr line. `JSON.stringify` mirrors
 * Go's `%q` for the ASCII/printable-Unicode values these flags carry —
 * including `\n`/`\r` escapes in multiline values (same precedent as
 * `sso.format.ts`).
 *
 * `options.alias` ports the `StringSliceVarP` shorthand (e.g. `start`'s
 * `-x`). pflag then frames the diagnostic with BOTH spellings — `invalid
 * argument %q for "-x, --exclude" flag: ...` (`errors.go:108-117` branches on
 * `flag.Shorthand`) — regardless of which one the user typed, so the alias
 * must be registered here (not piped on afterwards) for the framing to
 * stay byte-identical to Go.
 */
export function legacyStringSliceFlag(
  name: string,
  description: string,
  options?: { readonly alias?: string },
) {
  const alias = options?.alias;
  const pflagName = alias === undefined ? `--${name}` : `-${alias}, --${name}`;
  const base = Flag.string(name).pipe(Flag.withDescription(description), Flag.atLeast(0));
  return (alias === undefined ? base : base.pipe(Flag.withAlias(alias))).pipe(
    Flag.mapTryCatch(
      (rawValues) => legacyParseStringSliceFlag(rawValues),
      (err) =>
        err instanceof LegacyStringSliceFlagParseError
          ? `invalid argument ${JSON.stringify(err.value)} for "${pflagName}" flag: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
    ),
  );
}
