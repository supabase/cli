import type { CliOutput, HelpDoc } from "effect/cli";
import type { CliErrorSuggestionContext } from "../cli/subcommand-flag-suggestions.ts";
import { cliErrorCode, formatCliErrorsForDisplay } from "../cli/subcommand-flag-suggestions.ts";
import { subcommandScopes, targetHelpFor, withRemoteFlagValue } from "./target-help.ts";

export function jsonCliOutputFormatter(context?: CliErrorSuggestionContext): CliOutput.Formatter {
  return {
    formatHelpDoc: (doc: HelpDoc.HelpDoc) => {
      const scopes = subcommandScopes(doc, context?.rootCommand);
      const target = targetHelpFor(doc);
      const { annotations: _annotations, ...serializable } = withRemoteFlagValue(doc);
      return JSON.stringify({
        _tag: "Help",
        doc: {
          ...serializable,
          ...(target === undefined ? {} : { target }),
          ...(serializable.subcommands === undefined
            ? {}
            : {
                subcommands: serializable.subcommands.map((group) => ({
                  ...group,
                  commands: group.commands.map((sub) => {
                    const scope = scopes.get(sub.name);
                    return scope === undefined ? sub : { ...sub, target: { scope } };
                  }),
                })),
              }),
        },
      });
    },
    formatCliError: (error) =>
      JSON.stringify({
        _tag: "Error",
        error: { code: cliErrorCode(error), message: error.message },
      }),
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
