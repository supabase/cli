import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Per-command `--output`/`-o` enums. The CLI exposes one global `OutputFlag` whose choice set is
 * the union of every command's accepted values (see `command-internal/global-flags.ts`), so each
 * command declares its own accepted subset here and the command wrapper
 * (`withCommandTelemetry`) rejects anything outside it.
 */

/** Accepted `-o`/`--output` values for most resource commands. */
export const RESOURCE_OUTPUT_FORMATS = ["env", "pretty", "json", "toml", "yaml"] as const;

/** Accepted `-o`/`--output` values for `db query`. */
export const QUERY_OUTPUT_FORMATS = ["json", "table", "csv"] as const;

/**
 * Raised when `-o`/`--output` carries a value the active command doesn't accept. The message
 * matches the established pflag rejection format: `invalid argument %q for %q flag: %v`.
 */
export class InvalidOutputFormatError extends Data.TaggedError("InvalidOutputFormatError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** Formats the accepted-values list for an invalid `-o`/`--output` error. */
export function outputFormatEnumMessage(allowed: ReadonlyArray<string>): string {
  return `must be one of [ ${allowed.join(" | ")} ]`;
}

/**
 * The full rejection message for an invalid `-o` value, matching the established
 * `invalid argument %q for %q flag: %v` pflag format.
 */
export function invalidOutputFormatMessage(value: string, allowed: ReadonlyArray<string>): string {
  return `invalid argument "${value}" for "-o, --output" flag: ${outputFormatEnumMessage(allowed)}`;
}

/** Directs commands that do not support the legacy output flag to `--output-format`. */
export function unsupportedOutputFlagMessage(command: string): string {
  return `the -o/--output flag is not supported by ${command}; use --output-format json|stream-json instead.`;
}
