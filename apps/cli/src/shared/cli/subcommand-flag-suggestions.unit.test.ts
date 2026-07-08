import { CliError, Command } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { legacyBranchesCommand } from "../../legacy/commands/branches/branches.command.ts";
import { legacyNetworkRestrictionsCommand } from "../../legacy/commands/network-restrictions/network-restrictions.command.ts";
import { formatCliErrorsForDisplay } from "./subcommand-flag-suggestions.ts";

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyBranchesCommand, legacyNetworkRestrictionsCommand]),
);

describe("subcommand flag placement suggestions", () => {
  it("suggests moving a subcommand flag after the attempted subcommand", () => {
    const errors = formatCliErrorsForDisplay(
      [
        new CliError.UnrecognizedOption({
          option: "--project-ref",
          command: ["supabase", "network-restrictions"],
          suggestions: [],
        }),
        new CliError.UnknownSubcommand({
          subcommand: "jacraenyzrorgjhsdvvf",
          parent: ["supabase", "network-restrictions"],
          suggestions: [],
        }),
      ],
      {
        rootCommand: testRoot,
        args: [
          "network-restrictions",
          "--project-ref",
          "jacraenyzrorgjhsdvvf",
          "get",
          "--experimental",
        ],
      },
    );

    expect(errors.changed).toBe(true);
    expect(errors.errors).toHaveLength(1);
    expect(errors.errors[0]?.message).toContain(
      "Unrecognized flag: --project-ref in command supabase network-restrictions",
    );
    expect(errors.errors[0]?.message).toContain(
      "Hint: --project-ref is available on `supabase network-restrictions get` and `supabase network-restrictions update`.",
    );
    expect(errors.errors[0]?.message).toContain(
      "supabase network-restrictions get --project-ref <value>",
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
          option: "--project-ref",
          command: ["supabase", "branches"],
          suggestions: [],
        }),
        new CliError.UnknownSubcommand({
          subcommand: "abcdefghijklmnopqrst",
          parent: ["supabase", "branches"],
          suggestions: [],
        }),
      ],
      {
        rootCommand: testRoot,
        args: ["branches", "--project-ref", "abcdefghijklmnopqrst", "get"],
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
          option: "--project-ref=jacraenyzrorgjhsdvvf",
          command: ["supabase", "network-restrictions"],
          suggestions: [],
        }),
      ],
      {
        rootCommand: testRoot,
        args: ["network-restrictions", "--project-ref=jacraenyzrorgjhsdvvf", "get"],
      },
    );

    expect(errors.changed).toBe(true);
    expect(errors.errors[0]?.message).toContain(
      "Hint: --project-ref is available on `supabase network-restrictions get` and `supabase network-restrictions update`.",
    );
    expect(errors.errors[0]?.message).toContain(
      "supabase network-restrictions get --project-ref <value>",
    );
    expect(errors.errors[0]?.message).not.toContain("--project-ref=jacraenyzrorgjhsdvvf <value>");
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
    // Real failure text from effect@4.0.0-beta.93's schema-backed `Primitive.integer`
    // (also affects `float`, `boolean`, and `date` — every primitive whose parse
    // failure happens to start with the word "Expected" hits the same doubling).
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
    // Real failure text from effect@4.0.0-beta.93's `Primitive.keyValuePair` —
    // it never starts with the word "Expected", so it isn't doubled by
    // `CliError.InvalidValue`'s own "Expected: " prefix and needs no rewriting.
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

  it("does not corrupt a value that itself contains the literal 'Expected: Expected' text", () => {
    // Regression test: the fix must anchor on `error.expected` (the field the
    // buggy primitive actually populates) rather than searching the fully
    // composed `error.message`, since `error.value` is user-controlled and is
    // interpolated into that same message twice (once directly, once again
    // inside `expected`'s "got <value>" suffix). A value that happens to
    // contain the literal doubled-prefix text must be left untouched.
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
