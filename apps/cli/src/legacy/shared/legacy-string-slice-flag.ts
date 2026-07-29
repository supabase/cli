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

/**
 * Go's `encoding/csv` reports `ParseError.Column` as a **1-based byte offset**
 * within the input line (`reader.go` tracks `pos.col` in bytes, not runes) —
 * verified against the real Go CLI: `é"x` fails at column 3 (`é` is 2 UTF-8
 * bytes), not 2.
 */
const utf8ByteOffset = (val: string, index: number): number =>
  new TextEncoder().encode(val.slice(0, index)).length + 1;

/** Thrown by `legacyParseStringSliceFlag` when a value is not valid CSV. */
export class LegacyStringSliceFlagParseError extends Error {
  readonly value: string;
  readonly column: number;
  readonly detail: string;
  constructor(value: string, column: number, detail: string) {
    super(`parse error on line 1, column ${column}: ${detail}`);
    this.name = "LegacyStringSliceFlagParseError";
    this.value = value;
    this.column = column;
    this.detail = detail;
  }
}

/**
 * Parses one CSV record from `val`, matching Go's `encoding/csv` defaults used by
 * pflag's `StringSlice.Set` (`readAsCSV` → `csv.NewReader`).
 *
 * Rules: comma delimiter, double-quote quoting, `""` escapes a literal quote.
 * Whitespace is preserved (Go does not trim). An empty string returns `[]`.
 *
 * **Throws `LegacyStringSliceFlagParseError`** on any of the three malformed-CSV
 * conditions that Go's `csv.Reader` rejects:
 *   - Quoted field with no closing quote (`"tenant`) → "extraneous or missing \" in quoted-field"
 *   - Extra non-comma bytes after a closing quote (`"a"b`) → "extraneous or missing \" in quoted-field"
 *   - A bare `"` inside an unquoted field (`a"b`) → "bare \" in non-quoted-field"
 */
function readAsCSVStrict(val: string): string[] {
  if (val === "") return [];
  const fields: string[] = [];
  let i = 0;
  while (i < val.length) {
    if (val[i] === '"') {
      // Quoted field: accumulate until the closing (unescaped) quote.
      i++; // skip opening quote
      let field = "";
      let closed = false;
      while (i < val.length) {
        if (val[i] === '"') {
          if (i + 1 < val.length && val[i + 1] === '"') {
            field += '"';
            i += 2; // "" → single "
          } else {
            i++; // skip closing quote
            closed = true;
            break;
          }
        } else {
          field += val[i++];
        }
      }
      if (!closed) {
        // Ran off the end without finding a closing quote. Go's csv.Reader
        // hits EOF here, so the reported column is one past the final byte.
        throw new LegacyStringSliceFlagParseError(
          val,
          utf8ByteOffset(val, val.length),
          `extraneous or missing " in quoted-field`,
        );
      }
      // After the closing quote only a comma or end-of-string is allowed.
      // Go reports the byte position of the closing quote itself
      // (`reader.go`: `pos.col - quoteLen`) — `i` already skipped past it.
      if (i < val.length && val[i] !== ",") {
        throw new LegacyStringSliceFlagParseError(
          val,
          utf8ByteOffset(val, i - 1),
          `extraneous or missing " in quoted-field`,
        );
      }
      fields.push(field);
    } else {
      // Unquoted field: a bare `"` anywhere inside is illegal. Go reports
      // the byte position of the offending quote.
      const start = i;
      while (i < val.length && val[i] !== ",") {
        if (val[i] === '"') {
          throw new LegacyStringSliceFlagParseError(
            val,
            utf8ByteOffset(val, i),
            `bare " in non-quoted-field`,
          );
        }
        i++;
      }
      fields.push(val.slice(start, i));
    }
    // Consume the delimiter; a trailing comma produces one more empty field.
    if (i < val.length && val[i] === ",") {
      i++;
      if (i === val.length) {
        fields.push(""); // trailing comma → empty trailing field
      }
    }
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
 *   - empty string → no field
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
 * Builds a legacy flag that ports a shorthand-less pflag `StringSliceVar`:
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
 * Go's `%q` for the ASCII/printable-Unicode values these flags carry (same
 * precedent as `sso.format.ts`).
 */
export function legacyStringSliceFlag(name: string, description: string) {
  return Flag.string(name).pipe(
    Flag.withDescription(description),
    Flag.atLeast(0),
    Flag.mapTryCatch(
      (rawValues) => legacyParseStringSliceFlag(rawValues),
      (err) =>
        err instanceof LegacyStringSliceFlagParseError
          ? `invalid argument ${JSON.stringify(err.value)} for "--${name}" flag: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
    ),
  );
}
