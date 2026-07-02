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
});
