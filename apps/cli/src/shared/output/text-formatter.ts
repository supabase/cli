import { CliOutput } from "effect/unstable/cli";
import type {
  CliErrorSuggestionContext,
  FormattedCliError,
} from "../cli/subcommand-flag-suggestions.ts";
import { formatCliErrorsForDisplay } from "../cli/subcommand-flag-suggestions.ts";

export function textCliOutputFormatter(context?: CliErrorSuggestionContext): CliOutput.Formatter {
  const base = CliOutput.defaultFormatter({ colors: false });
  return {
    ...base,
    formatErrors: (errors) => {
      const formatted = formatCliErrorsForDisplay(errors, context);
      if (formatted.length === 0) return "";
      if (formatted.length === 1) {
        return `\nERROR\n  ${formatted[0]?.message}`;
      }

      const sections = ["\nERRORS"];
      const grouped = new Map<string, Array<FormattedCliError>>();
      for (const error of formatted) {
        const group = grouped.get(error._tag) ?? [];
        group.push(error);
        grouped.set(error._tag, group);
      }
      for (const group of grouped.values()) {
        for (const error of group) {
          sections.push(`  ${error.message}`);
        }
      }
      return sections.join("\n");
    },
    formatVersion: (_name, version) => version,
  };
}
