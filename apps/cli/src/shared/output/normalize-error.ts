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

const readCauseMessage = (value: ErrorRecord): string | undefined => {
  const cause = value["cause"];
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (typeof cause === "string" && cause.trim().length > 0) return cause.trim();
  if (isErrorRecord(cause)) {
    return readString(cause, "message") ?? readString(cause, "detail");
  }
  return undefined;
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

    case "DaemonStartError":
      return {
        code: tag,
        message: readString(error, "message") ?? "Failed to start the Supabase daemon.",
        suggestion: "Check local resources and try `supabase start` again.",
      };
    case "DaemonUpgradeRequired": {
      const oldCliVersion = readString(error, "oldCliVersion") ?? "an older CLI";
      const newCliVersion = readString(error, "newCliVersion") ?? "the current CLI";
      return {
        code: tag,
        message: `The local Supabase stack is running under ${oldCliVersion}, but this CLI is ${newCliVersion}.`,
        suggestion: "Run `supabase start` to restart the stack with the current CLI.",
      };
    }
    case "StackUnavailableError": {
      const phase = readString(error, "phase");
      const detail = readString(error, "detail");
      const message =
        phase === "starting"
          ? "The local Supabase stack is still starting."
          : phase === "stopping"
            ? "The local Supabase stack is still stopping."
            : phase === "failed"
              ? "The local Supabase stack failed to start."
              : phase === "deleting"
                ? "The local Supabase stack is being deleted."
                : "The local Supabase stack is unavailable.";
      const suggestion =
        phase === "starting"
          ? "Wait for `supabase start` to finish, then try again."
          : phase === "stopping"
            ? "Wait for the current stop operation to finish, then try again."
            : phase === "failed"
              ? "Run `supabase start` again to recreate the local stack."
              : phase === "deleting"
                ? "Wait for the current delete operation to finish, then try again."
                : "Run `supabase start`, then retry the command.";
      return {
        code: tag,
        message,
        ...(detail === undefined ? {} : { detail }),
        suggestion,
      };
    }
    case "StackRpcTransportError": {
      const endpoint = readString(error, "endpoint") ?? "the local stack endpoint";
      const procedure = readString(error, "procedure") ?? "the requested operation";
      const cause = readCauseMessage(error);
      return {
        code: tag,
        message: "Could not communicate with the local Supabase stack.",
        detail: `RPC ${procedure} at ${endpoint} failed${cause === undefined ? "." : `: ${cause}`}`,
        suggestion: "Check that the stack is running, then retry the command.",
      };
    }
    case "StackRpcProtocolError": {
      const endpoint = readString(error, "endpoint") ?? "the local stack endpoint";
      const procedure = readString(error, "procedure") ?? "the requested operation";
      const detail = readString(error, "detail") ?? "the response did not match the RPC protocol";
      return {
        code: tag,
        message: "The local Supabase stack returned an invalid RPC response.",
        detail: `RPC ${procedure} at ${endpoint} failed protocol validation: ${detail}`,
        suggestion: "Restart the stack with `supabase start`, then retry the command.",
      };
    }
    case "StopTimeout": {
      const endpoint = readString(error, "endpoint") ?? "the local stack endpoint";
      const lastState = readString(error, "lastState");
      return {
        code: tag,
        message: "Timed out waiting for the local Supabase stack to stop.",
        detail: `The stack at ${endpoint} did not stop before the timeout${
          lastState === undefined ? "." : ` (last state: ${lastState}).`
        }`,
        suggestion: "Check `supabase status`, then retry `supabase stop`.",
      };
    }
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
    case "UnknownSubcommand":
      return {
        code: "UnknownSubcommand",
        message: readString(error, "message") ?? "Unknown subcommand",
      };
    case "ShowHelp": {
      // Effect CLI wraps parse errors in a ShowHelp envelope (`CliError.ts`)
      // whose `errors` array holds the underlying causes. If exactly one of
      // those is a known recoverable type with a Go-parity mapping, unwrap
      // and surface that instead of the generic "Help requested" envelope
      // message — otherwise the user sees a useless top-line above the real
      // problem.
      const errors = error["errors"];
      if (!Array.isArray(errors) || errors.length === 0) return undefined;

      if (errors.length === 1) {
        const inner = errors[0];
        if (isErrorRecord(inner)) {
          const innerMapped = mappedError(inner, context);
          if (innerMapped) return innerMapped;
        }
      }

      // No Go-parity-specific single-error mapping applies (either more than
      // one simultaneous error, e.g. a child flag placed before its
      // subcommand — `UnrecognizedOption` plus the `UnknownSubcommand` its
      // misplaced value gets parsed as — or a lone error with no known
      // mapping: UnrecognizedOption, DuplicateOption, MissingArgument,
      // UnknownSubcommand, UserError, or an InvalidValue that doesn't hit
      // CLI-1898's doubled-"Expected"-prefix bug). Surface every inner
      // error's own message — reusing the same `formatCliErrorsForDisplay`
      // the text/json formatters use, so a subcommand-flag hint (e.g. "Hint:
      // --foo is available on `branches create`. Pass it after the
      // subcommand") survives — rather than falling through to ShowHelp's
      // useless "Help requested" envelope message: since CLI-1901 (`run.ts`'s
      // `withoutParseErrorHelpDump`) stopped the vendored library from also
      // `Console.error`-ing this same text, this is now the ONLY place any
      // of it reaches the user, for one error or many.
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

      // Defensive fallback for a single inner value that carries a usable
      // `_tag`/`message` pair but isn't a real `CliError` instance (e.g. a
      // hand-rolled test double) — real `ShowHelp.errors` entries always are.
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
    // Raw read: some producers' suggestion text is meaningful leading/trailing
    // whitespace, not incidental — e.g. `suggestLegacyBundle`'s Go-parity
    // string (`shared/functions/download.ts`) starts with `\n` to reproduce
    // Go's blank separator line before the hint (`cmd/root.go:301-302`,
    // `Fprintln(os.Stderr, CmdSuggestion)`). `readString` would trim exactly
    // that away.
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
