import { Cause, Option } from "effect";
import { CliError } from "effect/unstable/cli";
import { formatInvalidValueMessage } from "../cli/invalid-value-message.ts";
import type { CliErrorSuggestionContext } from "../cli/subcommand-flag-suggestions.ts";
import { formatCliErrorsForDisplay } from "../cli/subcommand-flag-suggestions.ts";

type NormalizedCliError = {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
};

type ErrorRecord = Record<string, unknown>;

const isErrorRecord = (value: unknown): value is ErrorRecord =>
  typeof value === "object" && value !== null;

const readString = (value: ErrorRecord, key: string): string | undefined => {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
};

// Unlike `readString`, does not trim or reject empty strings: some fields
// carry raw user input (e.g. `CliError.InvalidValue#value`) where an empty
// string or meaningful whitespace is a legitimate value that must be
// reported verbatim.
const readRawString = (value: ErrorRecord, key: string): string | undefined => {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
};

const mappedError = (
  error: ErrorRecord,
  context?: CliErrorSuggestionContext,
): NormalizedCliError | undefined => {
  const tag = readString(error, "_tag");
  switch (tag) {
    case "MissingOption": {
      // Matches the CLI's established `required flag(s) "X" not set` wording
      // (not Effect CLI's default `Missing required flag: --X`) so scripts
      // parsing stderr keep working. The pre-error help dump above it can't
      // be suppressed without forking the parser.
      const option = readString(error, "option");
      return {
        code: tag,
        message: option
          ? `Error: required flag(s) "${option}" not set`
          : "Error: required flag(s) not set",
      };
    }
    case "InvalidValue": {
      // A global-flag `InvalidValue` (`--output-format`, `--output`/`-o`,
      // `--dns-resolver`, `--agent`) bypasses `CliOutput.Formatter` and lands
      // here; apply the same doubled-"Expected"-prefix fix as the `ShowHelp` path.
      const option = readString(error, "option");
      // Raw read: `value` is the exact argv token typed by the user and may
      // legitimately be `""` or carry whitespace; `readString` would trim or
      // drop it, masking the bug this case exists to fix.
      const value = readRawString(error, "value");
      const expected = readString(error, "expected");
      const kind = readString(error, "kind");
      if (
        option !== undefined &&
        value !== undefined &&
        expected !== undefined &&
        (kind === "flag" || kind === "argument")
      ) {
        const message = formatInvalidValueMessage({ option, value, expected, kind });
        if (message !== undefined) return { code: tag, message };
      }
      return undefined;
    }
    case "UnknownSubcommand":
      return {
        code: "UnknownSubcommand",
        message: readString(error, "message") ?? "Unknown subcommand",
      };
    case "ShowHelp": {
      // `ShowHelp` wraps parse errors; if exactly one inner error has a known
      // mapping here, surface that instead of the generic "Help requested"
      // envelope message.
      const errors = error["errors"];
      if (!Array.isArray(errors) || errors.length === 0) return undefined;

      if (errors.length === 1) {
        const inner = errors[0];
        if (isErrorRecord(inner)) {
          const innerMapped = mappedError(inner, context);
          if (innerMapped) return innerMapped;
        }
      }

      // No known single-error mapping applies. Reuse
      // `formatCliErrorsForDisplay` so subcommand-flag hints survive, rather
      // than falling through to the generic "Help requested" envelope message.
      if (errors.every(CliError.isCliError)) {
        const formatted = formatCliErrorsForDisplay(errors, context);
        if (formatted.errors.length > 0) {
          const [only] = formatted.errors;
          return {
            code: formatted.errors.length === 1 && only ? only._tag : "ShowHelp",
            message: formatted.errors.map((formattedError) => formattedError.message).join("\n\n"),
          };
        }
      }

      // Defensive fallback for an inner value with a usable `_tag`/`message`
      // pair but not a real `CliError` instance (e.g. a hand-rolled test
      // double); real `ShowHelp.errors` entries always are.
      if (errors.length === 1) {
        const inner = errors[0];
        if (isErrorRecord(inner)) {
          const code = readString(inner, "_tag");
          const message = readString(inner, "message");
          if (code && message) return { code, message };
        }
      }
      return undefined;
    }
  }
};

export function normalizeCliError(
  error: unknown,
  context?: CliErrorSuggestionContext,
): NormalizedCliError {
  if (isErrorRecord(error)) {
    const mapped = mappedError(error, context);
    if (mapped) {
      return mapped;
    }

    const code = readString(error, "_tag") ?? "UnknownError";
    const message = readString(error, "message") ?? readString(error, "detail") ?? code;
    const detail = readString(error, "detail");
    // Raw read: some producers' suggestion text carries meaningful leading
    // whitespace (e.g. `suggestLegacyBundle`'s leading `\n` for a blank
    // separator line); `readString` would trim exactly that away.
    const suggestion = readRawString(error, "suggestion");
    return {
      code,
      message,
      ...(detail && detail !== message ? { detail } : {}),
      ...(suggestion !== undefined && suggestion.length > 0 ? { suggestion } : {}),
    };
  }

  if (error instanceof Error) {
    return {
      code: error.name || "Error",
      message: error.message || "Unknown error",
    };
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return {
      code: "UnknownError",
      message: error.trim(),
    };
  }

  return {
    code: "UnknownError",
    message: "Unknown error",
  };
}

export function normalizeCause(
  cause: Cause.Cause<unknown>,
  context?: CliErrorSuggestionContext,
): NormalizedCliError {
  const errorOption = Cause.findErrorOption(cause);
  return normalizeCliError(
    Option.getOrElse(errorOption, () => Cause.squash(cause)),
    context,
  );
}

export function formatCliError(error: NormalizedCliError): string {
  const lines = [error.message];
  if (error.detail && error.detail !== error.message) {
    lines.push(`Detail: ${error.detail}`);
  }
  if (error.suggestion) {
    lines.push(`Suggestion: ${error.suggestion}`);
  }
  return lines.join("\n");
}
