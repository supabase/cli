/**
 * Normalizes a repeated `--schema` flag into a flat list, matching the CSV-per-occurrence
 * parsing every `--schema`-accepting delegated Go subprocess expects (shared logic lives in
 * `string-slice-flag.ts`). Also provides `schemaToCsvField`, the CSV re-encoder used when
 * forwarding `--schema` back to that subprocess.
 *
 * Shared by `gen types`, `db lint`, `db dump`, `db pull`, `db diff`, and `db schema
 * {generate,sync}`.
 */
import { parseStringSliceFlag, StringSliceFlagParseError } from "./string-slice-flag.ts";

export { StringSliceFlagParseError as SchemaFlagParseError };

export const parseSchemaFlags = parseStringSliceFlag;

// Whether a CSV field must be quoted (matches the `encoding/csv` writer a delegated Go
// subprocess re-parses): never quote the empty string; always quote `\.`; quote when the
// field contains `,`, `"`, `\r`, or `\n`; otherwise quote when the first rune is whitespace.
function fieldNeedsQuotes(field: string): boolean {
  if (field === "") return false;
  if (field === "\\.") return true;
  if (/[\n\r",]/u.test(field)) return true;
  return /^\s/u.test(field);
}

/**
 * Serializes a single parsed schema value back into one CSV field — the inverse of
 * `readAsCSVStrict` for one element. A schema parsed from `--schema '"tenant,one"'` is the
 * single value `tenant,one`; forwarding it raw to a delegated Go subprocess would let pflag's
 * `StringSlice` re-parse it as CSV and split it into two schemas, so this re-encodes it to
 * keep it one field when rebuilding argv for `db diff`/`db pull`.
 */
export function schemaToCsvField(value: string): string {
  if (!fieldNeedsQuotes(value)) return value;
  return `"${value.split('"').join('""')}"`;
}
