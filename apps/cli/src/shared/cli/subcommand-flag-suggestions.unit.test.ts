import { CliError, Command } from "effect/cli";
import { describe, expect, it } from "vitest";
import { branchesCommand } from "../../commands/branches/branches.command.ts";
import { networkRestrictionsCommand } from "../../commands/network-restrictions/network-restrictions.command.ts";
import { ssoCommand } from "../../commands/sso/sso.command.ts";
import { formatCliErrorsForDisplay } from "./subcommand-flag-suggestions.ts";

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([branchesCommand, networkRestrictionsCommand, ssoCommand]),
);

describe("subcommand flag placement suggestions", () => {
  it("suggests moving a subcommand flag after the attempted subcommand", () => {
    const errors = formatCliErrorsForDisplay(
      [
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
      ],
      {
        rootCommand: testRoot,
        args: ["sso", "--attribute-mapping-file", "mapping.json", "add", "--experimental"],
      },
    );

    expect(errors.changed).toBe(true);
    expect(errors.errors).toHaveLength(1);
    expect(errors.errors[0]?.message).toContain(
      "Unrecognized flag: --attribute-mapping-file in command supabase sso",
    );
    expect(errors.errors[0]?.message).toContain(
      "Hint: --attribute-mapping-file is available on `supabase sso add` and `supabase sso update`.",
    );
    expect(errors.errors[0]?.message).toContain(
      "supabase sso add --attribute-mapping-file <value>",
    );
    expect(errors.errors[0]?.message).not.toContain("Unknown subcommand");
  });

  it("leaves unrelated unrecognized flags unchanged", () => {
    const errors = formatCliErrorsForDisplay(
      [
        new CliError.UnrecognizedOption({
          option: "--definitely-not-a-child-flag",
          command: ["supabase", "network-restrictions"],
          suggestions: [],
        }),
      ],
      {
        rootCommand: testRoot,
        args: ["network-restrictions", "--definitely-not-a-child-flag", "get"],
      },
    );

    expect(errors.changed).toBe(false);
    expect(errors.errors).toHaveLength(1);
    expect(errors.errors[0]?.changed).toBe(false);
    expect(errors.errors[0]?.message).toBe(
      "Unrecognized flag: --definitely-not-a-child-flag in command supabase network-restrictions",
    );
  });

  it("omits hidden subcommands from placement hints", () => {
    const errors = formatCliErrorsForDisplay(
      [
        new CliError.UnrecognizedOption({
          option: "--remote=abcdefghijklmnopqrst",
          command: ["supabase", "branches"],
          suggestions: [],
        }),
      ],
      {
        rootCommand: testRoot,
        args: ["branches", "--remote=abcdefghijklmnopqrst", "get"],
      },
    );

    expect(errors.changed).toBe(true);
    expect(errors.errors).toHaveLength(1);
    expect(errors.errors[0]?.message).toContain("`supabase branches get`");
    expect(errors.errors[0]?.message).not.toContain("branches disable");
  });

  it("normalizes assigned flags in placement examples", () => {
    const errors = formatCliErrorsForDisplay(
      [
        new CliError.UnrecognizedOption({
          option: "--attribute-mapping-file=mapping.json",
          command: ["supabase", "sso"],
          suggestions: [],
        }),
      ],
      {
        rootCommand: testRoot,
        args: ["sso", "--attribute-mapping-file=mapping.json", "add"],
      },
    );

    expect(errors.changed).toBe(true);
    expect(errors.errors[0]?.message).toContain(
      "Hint: --attribute-mapping-file is available on `supabase sso add` and `supabase sso update`.",
    );
    expect(errors.errors[0]?.message).toContain(
      "supabase sso add --attribute-mapping-file <value>",
    );
    expect(errors.errors[0]?.message).not.toContain(
      "--attribute-mapping-file=mapping.json <value>",
    );
  });

  it("collapses the doubled 'Expected: Expected' prefix for an invalid choice flag value", () => {
    const errors = formatCliErrorsForDisplay([
      new CliError.InvalidValue({
        option: "size",
        value: "nano",
        expected: 'Expected "micro" | "small" | "medium", got "nano"',
        kind: "flag",
      }),
    ]);

    expect(errors.changed).toBe(true);
    expect(errors.errors).toHaveLength(1);
    expect(errors.errors[0]?.message).toBe(
      'Invalid value for flag --size: "nano". Expected "micro" | "small" | "medium", got "nano"',
    );
    expect(errors.errors[0]?.message).not.toMatch(/Expected:\s*Expected/);
  });

  it("collapses the doubled 'Expected: Expected' prefix for an invalid choice argument value", () => {
    const errors = formatCliErrorsForDisplay([
      new CliError.InvalidValue({
        option: "level",
        value: "bogus",
        expected: 'Expected "debug" | "info", got "bogus"',
        kind: "argument",
      }),
    ]);

    expect(errors.changed).toBe(true);
    expect(errors.errors[0]?.message).toBe(
      'Invalid value for argument <level>: "bogus". Expected "debug" | "info", got "bogus"',
    );
    expect(errors.errors[0]?.message).not.toMatch(/Expected:\s*Expected/);
  });

  it("also collapses the doubled prefix for a non-choice primitive whose failure text starts with 'Expected' (e.g. an invalid integer flag value)", () => {
    // Real failure text from effect's schema-backed `Primitive.Int` (also affects `float`,
    // `boolean`, and `date`).
    const errors = formatCliErrorsForDisplay([
      new CliError.InvalidValue({
        option: "port",
        value: "abc",
        expected: 'Expected a string representing a finite number, got "abc"',
        kind: "flag",
      }),
    ]);

    expect(errors.changed).toBe(true);
    expect(errors.errors[0]?.message).toBe(
      'Invalid value for flag --port: "abc". Expected a string representing a finite number, got "abc"',
    );
    expect(errors.errors[0]?.message).not.toMatch(/Expected:\s*Expected/);
  });

  it("leaves invalid-value errors whose expected text does not start with 'Expected' unchanged", () => {
    // Real failure text from effect's `Primitive.KeyValuePair`, which never starts with
    // "Expected", so it needs no rewriting.
    const errors = formatCliErrorsForDisplay([
      new CliError.InvalidValue({
        option: "define",
        value: "bogus",
        expected: "Invalid key=value format. Expected format: key=value, got: bogus",
        kind: "flag",
      }),
    ]);

    expect(errors.changed).toBe(false);
    expect(errors.errors[0]?.changed).toBe(false);
    expect(errors.errors[0]?.message).toBe(
      'Invalid value for flag --define: "bogus". Expected: Invalid key=value format. Expected format: key=value, got: bogus',
    );
  });

  it("passes a complete `invalid argument` diagnostic through verbatim", () => {
    const invalidValueMessage =
      'invalid argument "\\"1.2.3.4" for "--db-unban-ip" flag: parse error on line 1, column 9: extraneous or missing " in quoted-field';
    const errors = formatCliErrorsForDisplay([
      new CliError.InvalidValue({
        option: "db-unban-ip",
        value: '"1.2.3.4',
        expected: invalidValueMessage,
        kind: "flag",
      }),
    ]);

    expect(errors.changed).toBe(true);
    expect(errors.errors[0]?.message).toBe(invalidValueMessage);
  });

  it("does not corrupt a value that itself contains the literal 'Expected: Expected' text", () => {
    const errors = formatCliErrorsForDisplay([
      new CliError.InvalidValue({
        option: "env",
        value: "Expected: Expected nano",
        expected: 'Expected "dev" | "staging" | "prod", got "Expected: Expected nano"',
        kind: "flag",
      }),
    ]);

    expect(errors.changed).toBe(true);
    expect(errors.errors[0]?.message).toBe(
      'Invalid value for flag --env: "Expected: Expected nano". Expected "dev" | "staging" | "prod", got "Expected: Expected nano"',
    );
  });
});
