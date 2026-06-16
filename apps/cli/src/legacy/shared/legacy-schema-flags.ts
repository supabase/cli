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

/**
 * Parses one CSV record from `val`, matching Go's `encoding/csv` defaults used by
 * pflag's `StringSlice.Set` (`readAsCSV` → `csv.NewReader`).
 *
 * Rules: comma delimiter, double-quote quoting, `""` escapes a literal quote.
 * Whitespace is preserved (Go does not trim). An empty string returns `[]`.
 */
function readAsCSV(val: string): string[] {
  if (val === "") return [];
  const fields: string[] = [];
  let i = 0;
  while (i < val.length) {
    if (val[i] === '"') {
      // Quoted field: accumulate until the closing (unescaped) quote.
      i++; // skip opening quote
      let field = "";
      while (i < val.length) {
        if (val[i] === '"') {
          if (i + 1 < val.length && val[i + 1] === '"') {
            field += '"';
            i += 2; // "" → single "
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          field += val[i++];
        }
      }
      fields.push(field);
    } else {
      // Unquoted field: read until next comma.
      const start = i;
      while (i < val.length && val[i] !== ",") i++;
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

export function legacyNormalizeSchemaFlags(raw: ReadonlyArray<string>): ReadonlyArray<string> {
  const schemas: string[] = [];
  for (const value of raw) {
    for (const field of readAsCSV(value)) {
      schemas.push(field);
    }
  }
  return schemas;
}
