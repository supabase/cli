/**
 * Normalizes a repeated `--schema` flag into the flat list Go produces.
 *
 * Go defines `--schema` as a Cobra `StringSliceVarP` on both `gen types`
 * (`apps/cli-go/cmd/gen.go:155`) and `db lint` (`apps/cli-go/cmd/db.go:506`).
 * pflag's `StringSlice.Set` parses each value via `encoding/csv` (`readAsCSV`
 * → `csv.NewReader`), so a quoted value like `"tenant,one"` is ONE element
 * (`tenant,one`) while `public,private` is two elements. Plain `split(",")` wrongly
 * breaks quoted commas.
 *
 * Whitespace is NOT trimmed and empty fields are NOT dropped: Go's csv.Reader
 * returns raw field values; pflag appends them directly to the slice.
 *
 * Shared by `gen types` and `db lint` (two command families).
 */

/** Thrown by `legacyParseSchemaFlags` when a `--schema` value is not valid CSV. */
export class LegacySchemaFlagParseError extends Error {
  readonly value: string;
  readonly detail: string;
  constructor(value: string, detail: string) {
    super(`parse error on line 1, column 0: ${detail}`);
    this.name = "LegacySchemaFlagParseError";
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
 * **Throws `LegacySchemaFlagParseError`** on any of the three malformed-CSV conditions
 * that Go's `csv.Reader` rejects:
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
        throw new LegacySchemaFlagParseError(val, `extraneous or missing " in quoted-field`);
      }
      // After the closing quote only a comma or end-of-string is allowed.
      if (i < val.length && val[i] !== ",") {
        throw new LegacySchemaFlagParseError(val, `extraneous or missing " in quoted-field`);
      }
      fields.push(field);
    } else {
      // Unquoted field: a bare `"` anywhere inside is illegal.
      const start = i;
      while (i < val.length && val[i] !== ",") {
        if (val[i] === '"') {
          throw new LegacySchemaFlagParseError(val, `bare " in non-quoted-field`);
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
 * CSV-parses and flattens all raw `--schema` occurrences.
 *
 * **Throws `LegacySchemaFlagParseError`** on the first malformed value, matching
 * Go's pflag parse-time behaviour where a bad `--schema` value fails the command
 * before it runs (Go: `invalid argument "..." for "-s, --schema" flag: parse error ...`).
 *
 * Valid behaviour:
 *   - `"tenant,one"` → `["tenant,one"]` (quoted comma stays one field)
 *   - `public,private` → `["public", "private"]`
 *   - no trimming, `""` escapes a literal quote inside a quoted field
 *   - empty string → no field
 */
export function legacyParseSchemaFlags(rawValues: ReadonlyArray<string>): ReadonlyArray<string> {
  const schemas: string[] = [];
  for (const value of rawValues) {
    for (const field of readAsCSVStrict(value)) {
      schemas.push(field);
    }
  }
  return schemas;
}

/**
 * Whether a CSV field must be quoted. Mirrors Go's `encoding/csv`
 * `Writer.fieldNeedsQuotes`: never quote the empty string; always quote `\.`;
 * quote when the field contains `,`, `"`, `\r`, or `\n`; otherwise quote when the
 * first rune is whitespace.
 */
function fieldNeedsQuotes(field: string): boolean {
  if (field === "") return false;
  if (field === "\\.") return true;
  if (/[\n\r",]/u.test(field)) return true;
  return /^\s/u.test(field);
}

/**
 * Serializes a SINGLE parsed schema value back into one CSV field — the inverse of
 * `readAsCSVStrict` for one element. A schema parsed from `--schema '"tenant,one"'`
 * is the single value `tenant,one`; forwarding it raw to the Go binary would let
 * pflag's `StringSlice` CSV-parse it a SECOND time and split it into two schemas.
 * Re-encoding (mirroring Go's `csv.Writer`) keeps it one field so the delegated
 * child sees exactly the schema set the native path would. Used when rebuilding
 * `--schema` argv for the Go-delegated `db diff` / `db pull` paths.
 */
export function legacySchemaToCsvField(value: string): string {
  if (!fieldNeedsQuotes(value)) return value;
  return `"${value.split('"').join('""')}"`;
}
