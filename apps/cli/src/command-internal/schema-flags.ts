/**
 * Normalizes a repeated `--schema` flag into a flat list (shared logic lives in
 * `string-slice-flag.ts`). Also provides `schemaToCsvField`, the CSV re-encoder used when
 * printing a `--schema` value back into a suggested shell command.
 *
 * Shared by `gen types`, `db lint`, `db dump`, `db pull`, `db diff`, and `db schema
 * {generate,sync}`.
 */
import { parseStringSliceFlag, StringSliceFlagParseError } from "./string-slice-flag.ts";

export { StringSliceFlagParseError as SchemaFlagParseError };

export const parseSchemaFlags = parseStringSliceFlag;

// Whether a CSV field must be quoted (matches Go's `encoding/csv` writer, so a printed
// suggestion round-trips through the same CSV parsing rules `--schema` values use): never quote
// the empty string; always quote `\.`; quote when the field contains `,`, `"`, `\r`, or `\n`;
// otherwise quote when the first rune is whitespace.
function fieldNeedsQuotes(field: string): boolean {
  if (field === "") return false;
  if (field === "\\.") return true;
  if (/[\n\r",]/u.test(field)) return true;
  return /^\s/u.test(field);
}

/**
 * Serializes a single parsed schema value back into one CSV field — the inverse of
 * `readAsCSVStrict` for one element. A schema parsed from `--schema '"tenant,one"'` is the
 * single value `tenant,one`; printing it raw into a suggested `--schema` command would let the
 * next CSV parse re-split it into two schemas, so this re-encodes it to keep it one field.
 */
export function schemaToCsvField(value: string): string {
  if (!fieldNeedsQuotes(value)) return value;
  return `"${value.split('"').join('""')}"`;
}
