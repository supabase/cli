import { CliOutput } from "effect/cli";
import {
  permissionSectionForHelp,
  renderPermissionsSection,
} from "../../command-internal/command-permissions/help-section.ts";
import type {
  CliErrorSuggestionContext,
  FormattedCliError,
} from "../cli/subcommand-flag-suggestions.ts";
import { formatCliErrorsForDisplay } from "../cli/subcommand-flag-suggestions.ts";
import { labelSubcommands, targetHelpFor, withRemoteFlagUsage } from "./target-help.ts";

function stripSingleErrorHeader(text: string): string {
  const prefix = "\nERROR\n  ";
  return text.startsWith(prefix) ? text.slice(prefix.length) : text.trimStart();
}

function insertBeforeUsage(text: string, section: string): string {
  const at = `\n${text}`.indexOf("\nUSAGE\n");
  return at === -1 ? text : `${text.slice(0, at)}${section}\n\n${text.slice(at)}`;
}

export function textCliOutputFormatter(context?: CliErrorSuggestionContext): CliOutput.Formatter {
  const base = CliOutput.defaultFormatter({ colors: false });
  const formatErrorMessage = (error: FormattedCliError) =>
    error.changed ? error.message : stripSingleErrorHeader(base.formatErrors([error.source]));

  return {
    ...base,
    formatHelpDoc: (doc) => {
      const text = base.formatHelpDoc(
        withRemoteFlagUsage(labelSubcommands(doc, context?.rootCommand)),
      );
      const target = targetHelpFor(doc);
      const withTarget =
        target === undefined ? text : insertBeforeUsage(text, `TARGET\n  ${target.summary}`);
      const section = permissionSectionForHelp(doc);
      return section === undefined
        ? withTarget
        : `${withTarget}\n\n${renderPermissionsSection(section)}`;
    },
    formatErrors: (errors) => {
      const formatted = formatCliErrorsForDisplay(errors, context);
      if (!formatted.changed) return base.formatErrors(errors);
      if (formatted.errors.length === 0) return "";
      if (formatted.errors.length === 1) {
        const [error] = formatted.errors;
        if (!error) return "";
        return error.changed ? `\nERROR\n  ${error.message}` : base.formatErrors([error.source]);
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
          sections.push(`  ${formatErrorMessage(error)}`);
        }
      }
      return sections.join("\n");
    },
    formatVersion: (_name, version) => version,
  };
}
