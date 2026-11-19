import { CliOutput } from "effect/cli";
import { withDeprecatedDescriptions } from "./subcommand-help.ts";
import { supportsColor, type ColorStream } from "../../command-internal/colors.ts";
import { withHelpMarkdown } from "./help-markdown.ts";
import { withOptionalSubcommandUsage } from "./optional-subcommand-usage.ts";
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
  let at = 0;
  for (const line of text.split("\n")) {
    if (Bun.stripANSI(line) === "USAGE") {
      return `${text.slice(0, at)}${section}\n\n${text.slice(at)}`;
    }
    at += line.length + 1;
  }
  return text;
}

export function textCliOutputFormatter(
  context?: CliErrorSuggestionContext,
  stream: ColorStream = process.stdout,
  agentMode = false,
): CliOutput.Formatter {
  const base = CliOutput.defaultFormatter({ colors: false });
  const formatErrorMessage = (error: FormattedCliError) =>
    error.changed ? error.message : stripSingleErrorHeader(base.formatErrors([error.source]));

  return {
    ...base,
    formatHelpDoc: (doc) => {
      const labeled = withDeprecatedDescriptions(doc, context?.rootCommand);
      const colors = supportsColor(stream, !agentMode);
      const help = CliOutput.defaultFormatter({ colors });
      const rendered = withHelpMarkdown(
        withOptionalSubcommandUsage(
          withRemoteFlagUsage(labelSubcommands(labeled, context?.rootCommand)),
        ),
        colors,
      );
      // Effect indents only the first line of the description section.
      const text = help.formatHelpDoc({
        ...rendered,
        description: rendered.description.replace(/\n(?=[^\n])/g, "\n  "),
      });
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
