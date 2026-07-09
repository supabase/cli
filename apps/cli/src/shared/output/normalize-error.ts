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

// Unlike `readString`, does not trim or reject empty strings. Use this for
// fields that carry raw user input (e.g. `CliError.InvalidValue#value`),
// where an empty string or meaningful surrounding whitespace is a legitimate
// value the user typed (`supabase --output-format ''`) and must be preserved
// and reported verbatim rather than normalized away.
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
    case "NoRunningStackError":
      return {
        code: tag,
        message: "No local Supabase stack is running for this project.",
        detail: "The CLI could not find a running stack for the current working directory.",
        suggestion:
          "Run `supabase start` in this project, or change into a directory with a running stack.",
      };
    case "StateNotFoundError": {
      const name = readString(error, "name");
      return {
        code: tag,
        message: "The requested local Supabase stack was not found.",
        ...(name ? { detail: `Missing stack state: ${name}.` } : {}),
        suggestion: "Run `supabase start` to create a new local stack.",
      };
    }
    case "DaemonStillRunningError": {
      const name = readString(error, "name");
      return {
        code: tag,
        message: "The local Supabase stack did not stop cleanly.",
        ...(name ? { detail: `Stack "${name}" is still running.` } : {}),
        suggestion: "Wait a moment and try `supabase stop` again.",
      };
    }
    case "StackAlreadyRunningError":
      return {
        code: tag,
        message:
          readString(error, "name") && typeof error.pid === "number"
            ? `A Supabase stack "${readString(error, "name")}" is already running (PID ${error.pid}).`
            : "A local Supabase stack is already running.",
        suggestion: "Use `supabase stop` before starting another stack for this project.",
      };
    case "DaemonStartError":
      return {
        code: tag,
        message: readString(error, "message") ?? "Failed to start the Supabase daemon.",
        suggestion: "Check local resources and try `supabase start` again.",
      };
    case "MissingOption": {
      // Mirror Go Cobra's `required flag(s) "X" not set` wording. Effect CLI's
      // default `Missing required flag: --X` differs and would break scripts
      // that parse the Go CLI's stderr. We still cannot suppress Effect CLI's
      // pre-error help dump (Cobra doesn't show it on parse error) — that
      // would require a forked CLI parser. Match what we can.
      const option = readString(error, "option");
      return {
        code: tag,
        message: option
          ? `Error: required flag(s) "${option}" not set`
          : "Error: required flag(s) not set",
      };
    }
    case "InvalidValue": {
      // `CliError.InvalidValue` for a `GlobalFlag.setting` flag (e.g.
      // `--output-format`, or the legacy `--output`/`-o`, `--dns-resolver`,
      // `--agent`) never reaches `CliOutput.Formatter` — `Command.runWith`
      // validates those flags in a step that runs outside the `ShowHelp`
      // path, so the failure lands here instead. Apply the same
      // doubled-"Expected"-prefix workaround `subcommand-flag-suggestions.ts`
      // applies for the `ShowHelp`-formatted case (see CLI-1898), so every
      // `InvalidValue` failure — whichever path it takes — renders the same
      // way.
      const option = readString(error, "option");
      // Raw read: `value` is the exact argv token the user typed and can
      // legitimately be `""` or carry surrounding whitespace — `readString`
      // would trim it or drop it entirely, either masking the bug this case
      // exists to fix or misreporting what the user actually typed.
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
    case "ShowHelp": {
      // Effect CLI wraps parse errors in a ShowHelp envelope (`CliError.ts`)
      // whose `errors` array holds the underlying causes. If exactly one of
      // those is a known recoverable type with a Go-parity mapping, unwrap
      // and surface that instead of the generic "Help requested" envelope
      // message — otherwise the user sees a useless top-line above the real
      // problem.
      const errors = error["errors"];
      if (Array.isArray(errors) && errors.length === 1) {
        const inner = errors[0];
        if (isErrorRecord(inner)) {
          const innerMapped = mappedError(inner, context);
          if (innerMapped) return innerMapped;
          // No Go-parity-specific mapping exists for this inner tag (e.g.
          // UnrecognizedOption, DuplicateOption, MissingArgument,
          // UnknownSubcommand, UserError — or an InvalidValue that doesn't
          // hit CLI-1898's doubled-"Expected"-prefix bug). Surface the inner
          // error's own message rather than falling through to ShowHelp's
          // useless "Help requested": since CLI-1901 (`run.ts`'s
          // `withoutParseErrorHelpDump`) stopped the vendored library from
          // also `Console.error`-ing this same text, this is now the ONLY
          // place it reaches the user. Reuse the same `formatCliErrorsForDisplay`
          // the text/json formatters use (rather than the raw `.message`
          // getter) so a subcommand-flag hint (e.g. "Hint: --foo is available
          // on `branches create`. Pass it after the subcommand") that used to
          // reach the user via the library's now-suppressed duplicate render
          // still survives through this single-render path.
          if (CliError.isCliError(inner)) {
            const [formatted] = formatCliErrorsForDisplay([inner], context).errors;
            if (formatted) return { code: formatted._tag, message: formatted.message };
          }
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
    const suggestion = readString(error, "suggestion");
    return {
      code,
      message,
      ...(detail && detail !== message ? { detail } : {}),
      ...(suggestion ? { suggestion } : {}),
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
