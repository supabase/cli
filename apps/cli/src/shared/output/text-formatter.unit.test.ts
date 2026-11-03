import { CliError, Command } from "effect/cli";
import { describe, expect, it } from "vitest";
import { ssoCommand } from "../../commands/sso/sso.command.ts";
import { textCliOutputFormatter } from "./text-formatter.ts";

const testRoot = Command.make("supabase").pipe(Command.withSubcommands([ssoCommand]));

describe("textCliOutputFormatter", () => {
  it("preserves default parser suggestions for unchanged errors", () => {
    const formatter = textCliOutputFormatter();

    const text = formatter.formatErrors([
      new CliError.UnrecognizedOption({
        option: "--pla",
        command: ["supabase", "projects", "create"],
        suggestions: ["--plan"],
      }),
    ]);

    expect(text).toContain("Unrecognized flag: --pla in command supabase projects create");
    expect(text).toContain("Did you mean this?");
    expect(text).toContain("--plan");
  });

  it("preserves default parser suggestions for unchanged siblings in rewritten errors", () => {
    const formatter = textCliOutputFormatter({
      rootCommand: testRoot,
      args: ["sso", "--attribute-mapping-file", "mapping.json", "add", "--pla"],
    });

    const text = formatter.formatErrors([
      new CliError.UnrecognizedOption({
        option: "--attribute-mapping-file",
        command: ["supabase", "sso"],
        suggestions: [],
      }),
      new CliError.UnknownSubcommand({
        subcommand: "mapping.json",
        parent: ["supabase", "sso"],
        suggestions: [],
      }),
      new CliError.UnrecognizedOption({
        option: "--pla",
        command: ["supabase", "projects", "create"],
        suggestions: ["--plan"],
      }),
    ]);

    expect(text).toContain("Hint: --attribute-mapping-file is available on");
    expect(text).toContain("Unrecognized flag: --pla in command supabase projects create");
    expect(text).toContain("Did you mean this?");
    expect(text).toContain("--plan");
  });

  it("does not double the 'Expected' prefix for an invalid choice flag value", () => {
    const formatter = textCliOutputFormatter();

    const text = formatter.formatErrors([
      new CliError.InvalidValue({
        option: "size",
        value: "nano",
        expected: 'Expected "micro" | "small" | "medium", got "nano"',
        kind: "flag",
      }),
    ]);

    expect(text).toContain(
      'Invalid value for flag --size: "nano". Expected "micro" | "small" | "medium", got "nano"',
    );
    expect(text).not.toMatch(/Expected:\s*Expected/);
  });
});
