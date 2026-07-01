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
      if (!formatted.changed) return base.formatErrors(errors);
      if (formatted.errors.length === 0) return "";
      if (formatted.errors.length === 1) {
        return `\nERROR\n  ${formatted.errors[0]?.message}`;
      }

      const sections = ["\nERRORS"];
      const grouped = new Map<string, Array<FormattedCliError>>();
      for (const error of formatted.errors) {
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
