import { CliError } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "./error-actionability.ts";

describe("retained external error actionability", () => {
  it("classifies every parser failure through the real Effect error objects", () => {
    const errors = [
      new CliError.MissingOption({ option: "--token" }),
      new CliError.MissingArgument({ argument: "project-ref" }),
      new CliError.DuplicateOption({
        option: "debug",
        parentCommand: "root",
        childCommand: "start",
      }),
      new CliError.UnexpectedArgument({ arguments: ["private-value"] }),
      new CliError.InvalidValue({
        option: "output",
        value: "private-value",
        expected: "text",
        kind: "flag",
      }),
      new CliError.UnknownSubcommand({
        subcommand: "private-command",
        parent: [],
        suggestions: [],
      }),
      new CliError.UnrecognizedOption({ option: "private-option", suggestions: [] }),
    ];

    for (const error of errors) {
      expect(classifyCliErrorActionability(error)).toMatchObject({
        error_kind: "user_actionable",
        error_category: "invalid_input",
        has_suggestion: false,
        suggestion_type: "none",
      });
    }
  });
});
