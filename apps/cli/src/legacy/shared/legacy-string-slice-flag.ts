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

/** Thrown by `legacyParseStringSliceFlag` when a value is not valid CSV. */
export class LegacyStringSliceFlagParseError extends Error {
  readonly value: string;
  readonly detail: string;
  constructor(value: string, detail: string) {
    super(`parse error on line 1, column 0: ${detail}`);
    this.name = "LegacyStringSliceFlagParseError";
    this.value = value;
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
        // Ran off the end without finding a closing quote.
        throw new LegacyStringSliceFlagParseError(val, `extraneous or missing " in quoted-field`);
      }
      // After the closing quote only a comma or end-of-string is allowed.
      if (i < val.length && val[i] !== ",") {
        throw new LegacyStringSliceFlagParseError(val, `extraneous or missing " in quoted-field`);
      }
      fields.push(field);
    } else {
      // Unquoted field: a bare `"` anywhere inside is illegal.
      const start = i;
      while (i < val.length && val[i] !== ",") {
        if (val[i] === '"') {
          throw new LegacyStringSliceFlagParseError(val, `bare " in non-quoted-field`);
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
