import { Data } from "effect";

/**
 * Per-command `--output`/`-o` enums, mirroring Go. Go registers `--output` per
 * command with a strict `EnumFlag` (`internal/utils/enum.go`); the TS legacy
 * shell instead exposes ONE global `LegacyOutputFlag` whose choice is the union
 * of every command's values (see `shared/legacy/global-flags.ts`). Because that
 * single flag cannot vary its accepted set per command, each command declares
 * the subset its Go counterpart accepts and the command wrapper
 * (`withLegacyCommandInstrumentation`) rejects anything outside it — restoring
 * Go's per-command validation.
 */

/** Go's global `utils.OutputFormat` enum (`internal/utils/output.go:30-39`). */
export const LEGACY_RESOURCE_OUTPUT_FORMATS = ["env", "pretty", "json", "toml", "yaml"] as const;

/** Go's `db query` `queryOutput` enum (`cmd/db.go:285-288`). */
export const LEGACY_QUERY_OUTPUT_FORMATS = ["json", "table", "csv"] as const;

/**
 * Raised when `-o`/`--output` carries a value the active command does not accept.
 * The message is byte-identical to Go's pflag rejection: pflag wraps
 * `EnumFlag.Set`'s `must be one of [ a | b | c ]` (`enum.go:21-27`) in
 * `invalid argument %q for %q flag: %v` with the shorthand-prefixed flag name.
 */
export class LegacyInvalidOutputFormatError extends Data.TaggedError(
  "LegacyInvalidOutputFormatError",
)<{ readonly message: string }> {}

/** Go's `must be one of [ a | b | c ]` (`enum.go:23`, joined with `" | "`). */
export function legacyOutputFormatEnumMessage(allowed: ReadonlyArray<string>): string {
  return `must be one of [ ${allowed.join(" | ")} ]`;
}

/**
 * Go's full pflag rejection string for an invalid `-o` value
 * (`pflag InvalidValueError`: `invalid argument %q for %q flag: %v`, with the
 * `-o, --output` shorthand-prefixed name).
 */
export function legacyInvalidOutputFormatMessage(
  value: string,
  allowed: ReadonlyArray<string>,
): string {
  return `invalid argument "${value}" for "-o, --output" flag: ${legacyOutputFormatEnumMessage(allowed)}`;
}
