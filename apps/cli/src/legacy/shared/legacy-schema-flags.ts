/**
 * Normalizes a repeated `--schema` flag into the flat list Go produces.
 *
 * Go defines `--schema` as a Cobra `StringSliceVarP` on both `gen types`
 * (`apps/cli-go/cmd/gen.go:155`) and `db lint` (`apps/cli-go/cmd/db.go:506`).
 * The CSV-per-occurrence parsing itself lives in `legacy-string-slice-flag.ts`
 * (shared with every other Go `StringSliceVar` flag ported to the legacy
 * shell); this module re-exports it under the `--schema`-specific names and
 * adds `legacySchemaToCsvField`, the CSV re-encoder used when forwarding
 * `--schema` back to a delegated Go subprocess.
 *
 * Shared by `gen types`, `db lint`, `db dump`, `db pull`, `db diff`, and
 * `db schema {generate,sync}`.
 */
import {
  legacyParseStringSliceFlag,
  LegacyStringSliceFlagParseError,
} from "./legacy-string-slice-flag.ts";

export { LegacyStringSliceFlagParseError as LegacySchemaFlagParseError };

export const legacyParseSchemaFlags = legacyParseStringSliceFlag;

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
