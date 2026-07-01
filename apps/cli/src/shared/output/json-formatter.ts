import type { CliOutput, HelpDoc } from "effect/unstable/cli";
import type { CliErrorSuggestionContext } from "../cli/subcommand-flag-suggestions.ts";
import { formatCliErrorsForDisplay } from "../cli/subcommand-flag-suggestions.ts";

export function jsonCliOutputFormatter(context?: CliErrorSuggestionContext): CliOutput.Formatter {
  return {
    formatHelpDoc: (doc: HelpDoc.HelpDoc) => JSON.stringify({ _tag: "Help", doc }),
    formatCliError: (error) =>
      JSON.stringify({ _tag: "Error", error: { code: error._tag, message: error.message } }),
    formatError: (error) =>
      JSON.stringify({ _tag: "Error", error: { code: error._tag, message: error.message } }),
    formatVersion: (name, version) => JSON.stringify({ _tag: "Version", name, version }),
    formatErrors: (errors) =>
      JSON.stringify({
        _tag: "Errors",
        errors: formatCliErrorsForDisplay(errors, context).errors.map((e) => ({
          code: e._tag,
          message: e.message,
        })),
      }),
  };
}
