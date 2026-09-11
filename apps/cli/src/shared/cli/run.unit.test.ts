import { Cause } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";

import { branchesCommand } from "../../commands/branches/branches.command.ts";
import { migrationCommand } from "../../commands/migration/migration.command.ts";
import { ssoCommand } from "../../commands/sso/sso.command.ts";
import { GoChildExitError } from "../../command-internal/go-child-exit.error.ts";
import {
  classifyParseErrorConsoleOutput,
  exitCodeForFailure,
  extractCommandPath,
  hasRootHelpOrVersionFlag,
  rootFlagTokens,
  shouldReportFailure,
  shouldUseGlobalSignalInterrupt,
  hasRootVersionFlag,
} from "./run.ts";

// Real command tree, not a stand-in, so alias resolution (`flagAliasesFor`) has real
// `Flag.withAlias` declarations to walk.
const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([branchesCommand, migrationCommand, ssoCommand]),
);

describe("extractCommandPath", () => {
  it("returns positional command-path tokens", () => {
    expect(extractCommandPath(["functions", "serve"])).toEqual(["functions", "serve"]);
  });

  it("skips boolean global flags", () => {
    expect(extractCommandPath(["--debug", "functions", "serve"])).toEqual(["functions", "serve"]);
  });

  it("skips value-taking global flags and their values", () => {
    expect(
      extractCommandPath(["--workdir", "/tmp/app", "--network-id", "net", "functions", "serve"]),
    ).toEqual(["functions", "serve"]);
  });

  it("skips the built-in --log-level flag and its value", () => {
    expect(extractCommandPath(["--log-level", "error", "functions", "serve"])).toEqual([
      "functions",
      "serve",
    ]);
  });

  it("skips the built-in --completions flag and its shell value", () => {
    expect(extractCommandPath(["--completions", "bash", "--version"])).toEqual([]);
  });

  it("treats --flag=value as a single token", () => {
    expect(extractCommandPath(["--output-format=json", "functions", "serve"])).toEqual([
      "functions",
      "serve",
    ]);
  });

  it("skips short-cluster and separated boolean values", () => {
    expect(extractCommandPath(["-yo", "json", "--debug", "false", "start"])).toEqual(["start"]);
    expect(extractCommandPath(["-ho", "json", "start"])).toEqual(["start"]);
  });

  it("stops at the positional argument boundary", () => {
    expect(extractCommandPath(["--", "start"])).toEqual([]);
  });
});

describe("local shorthand clusters", () => {
  const localValues = (token: string) => token === "-p";

  it("does not read an attached local shorthand value as help", () => {
    expect(hasRootHelpOrVersionFlag(["link", "-ph"], localValues)).toBe(false);
  });

  it("recognizes help after boolean shorthand flags at subcommand depth", () => {
    expect(hasRootHelpOrVersionFlag(["link", "-xh"], localValues)).toBe(true);
  });

  it("skips a following token consumed by a local shorthand value flag", () => {
    expect([...rootFlagTokens(["link", "-p", "--debug"], localValues)]).toEqual([
      { token: "-p", index: 1 },
    ]);
  });
});

describe("shouldUseGlobalSignalInterrupt", () => {
  it("opts out for self-managed signal commands, even behind global flags", () => {
    expect(shouldUseGlobalSignalInterrupt(["functions", "serve"])).toBe(false);
    expect(
      shouldUseGlobalSignalInterrupt(["--workdir", "/tmp/app", "functions", "serve", "--debug"]),
    ).toBe(false);
  });

  it("opts in for ordinary commands, including native start/db start/db reset (each installs no signal handling of its own, so the global wrapper's rollback-on-interrupt/finalizers are the only thing that runs on Ctrl-C)", () => {
    expect(shouldUseGlobalSignalInterrupt(["functions", "list"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["db", "push"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["projects", "list"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["start"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["db", "start"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["db", "reset"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt([])).toBe(true);
  });
});

describe("exitCodeForFailure", () => {
  it("exits 0 for a clean ShowHelp failure (bare group command)", () => {
    const cause = Cause.fail(new CliError.ShowHelp({ commandPath: ["branches"], errors: [] }));
    expect(exitCodeForFailure(cause)).toBe(0);
  });

  it("exits 1 for a ShowHelp cause carrying a genuine validation error", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["branches"],
        errors: [new CliError.UnrecognizedOption({ option: "--bogus", suggestions: [] })],
      }),
    );
    expect(exitCodeForFailure(cause)).toBe(1);
  });

  it("exits 1 for a non-ShowHelp failure", () => {
    const cause = Cause.fail(new Error("boom"));
    expect(exitCodeForFailure(cause)).toBe(1);
  });

  it("exits 1 for a defect with no typed failure", () => {
    const cause = Cause.die(new Error("unexpected crash"));
    expect(exitCodeForFailure(cause)).toBe(1);
  });

  it("exits 130 when interrupted, regardless of any other failure reason", () => {
    expect(exitCodeForFailure(Cause.interrupt())).toBe(130);
  });

  it("exits with a GoChildExitError's exact exit code", () => {
    const cause = Cause.fail(
      new GoChildExitError({ exitCode: 130, message: "supabase-go exited with code 130" }),
    );
    expect(exitCodeForFailure(cause)).toBe(130);
  });
});

describe("shouldReportFailure", () => {
  it("does not report a clean exit (0)", () => {
    expect(shouldReportFailure(Cause.fail(new Error("unused")), 0)).toBe(false);
  });

  it("does not report an interrupt (130)", () => {
    expect(shouldReportFailure(Cause.interrupt(), 130)).toBe(false);
  });

  it("does not report a GoChildExitError", () => {
    const cause = Cause.fail(
      new GoChildExitError({ exitCode: 1, message: "supabase-go exited with code 1" }),
    );
    expect(shouldReportFailure(cause, 1)).toBe(false);
  });

  it("reports a non-ShowHelp failure", () => {
    expect(shouldReportFailure(Cause.fail(new Error("boom")), 1)).toBe(true);
  });

  it("still reports a ShowHelp failure carrying a genuine validation error (e.g. a missing required flag)", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["sso", "add"],
        errors: [new CliError.MissingOption({ option: "--type" })],
      }),
    );
    expect(shouldReportFailure(cause, 1)).toBe(true);
  });
});

// This suite covers the classifier; `run.integration.test.ts` covers the end-to-end
// buffering/flush behavior against real command definitions, and `run.e2e.test.ts` /
// `sso.e2e.test.ts` cover the real subprocess stdout/stderr streams.
describe("classifyParseErrorConsoleOutput", () => {
  it("drops the help dump for a missing required flag", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "sso", "add"],
        errors: [new CliError.MissingOption({ option: "type" })],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["sso", "add", "--project-ref", "x"],
      }),
    ).toBe("drop");
  });

  it("drops the help dump when every error is a missing required flag", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "sso", "add"],
        errors: [
          new CliError.MissingOption({ option: "type" }),
          new CliError.MissingOption({ option: "project-ref" }),
        ],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, { rootCommand: testRoot, args: ["sso", "add"] }),
    ).toBe("drop");
  });

  it("flushes the help dump to stderr for a required flag present on argv but missing its value", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "migration", "repair"],
        errors: [new CliError.MissingOption({ option: "status" })],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["migration", "repair", "20230101000000", "--status"],
      }),
    ).toBe("flush-help-doc-to-stderr");
  });

  it("drops the help dump for a missing required flag whose token only appears after the -- terminator", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "migration", "repair"],
        errors: [new CliError.MissingOption({ option: "status" })],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["migration", "repair", "--", "20230101000000", "--status"],
      }),
    ).toBe("drop");
  });

  it("flushes the help dump to stderr for a required flag present on argv by its short alias but missing its value", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "sso", "add"],
        errors: [new CliError.MissingOption({ option: "type" })],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, { rootCommand: testRoot, args: ["sso", "add", "-t"] }),
    ).toBe("flush-help-doc-to-stderr");
  });

  it("drops the help dump when a required flag's own token is consumed as a preceding value-taking flag's value", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "sso", "add"],
        errors: [new CliError.MissingOption({ option: "type" })],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["sso", "add", "--project-ref", "--type"],
      }),
    ).toBe("drop");
  });

  it("drops the help dump when a required flag's own token is consumed as a global value-taking flag's value", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "migration", "repair"],
        errors: [new CliError.MissingOption({ option: "status" })],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["migration", "repair", "--network-id", "--status", "--local", "20230101000000"],
      }),
    ).toBe("drop");
  });

  it("flushes the help dump to stderr for a required flag whose own token follows a -- consumed as a preceding value-taking flag's value", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "sso", "add"],
        errors: [new CliError.MissingOption({ option: "type" })],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["sso", "add", "--project-ref", "--", "--type"],
      }),
    ).toBe("flush-help-doc-to-stderr");
  });

  it("still drops the help dump for a missing required flag even when an unrelated flag shares a substring of its name", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "sso", "add"],
        errors: [new CliError.MissingOption({ option: "type" })],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["sso", "add", "--type-hint", "x"],
      }),
    ).toBe("drop");
  });

  it("flushes the help dump to stderr for an invalid Flag.Literals value", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "sso", "add"],
        errors: [
          new CliError.InvalidValue({
            option: "type",
            value: "bogus",
            expected: 'Expected "saml", got "bogus"',
            kind: "flag",
          }),
        ],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["sso", "add", "--type", "bogus"],
      }),
    ).toBe("flush-help-doc-to-stderr");
  });

  it("flushes the help dump to stderr for an unrecognized flag", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "branches"],
        errors: [new CliError.UnrecognizedOption({ option: "--bogus", suggestions: [] })],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["branches", "--bogus"],
      }),
    ).toBe("flush-help-doc-to-stderr");
  });

  it("flushes the help dump to stderr for a missing positional argument", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "sso", "show"],
        errors: [new CliError.MissingArgument({ argument: "id" })],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, { rootCommand: testRoot, args: ["sso", "show"] }),
    ).toBe("flush-help-doc-to-stderr");
  });

  it("flushes the help dump to stderr for a mix of error tags", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "sso", "add"],
        errors: [
          new CliError.MissingOption({ option: "type" }),
          new CliError.UnrecognizedOption({ option: "--bogus", suggestions: [] }),
        ],
      }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["sso", "add", "--bogus"],
      }),
    ).toBe("flush-help-doc-to-stderr");
  });

  it("flushes unchanged for a clean ShowHelp failure (bare group command / explicit --help)", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({ commandPath: ["supabase", "branches"], errors: [] }),
    );
    expect(
      classifyParseErrorConsoleOutput(cause, { rootCommand: testRoot, args: ["branches"] }),
    ).toBe("flush-unchanged");
  });

  it("flushes unchanged for a non-ShowHelp failure", () => {
    expect(
      classifyParseErrorConsoleOutput(Cause.fail(new Error("boom")), {
        rootCommand: testRoot,
        args: [],
      }),
    ).toBe("flush-unchanged");
  });

  it("flushes unchanged for an interrupt", () => {
    expect(
      classifyParseErrorConsoleOutput(Cause.interrupt(), { rootCommand: testRoot, args: [] }),
    ).toBe("flush-unchanged");
  });

  it("flushes unchanged for a defect with no typed failure", () => {
    expect(
      classifyParseErrorConsoleOutput(Cause.die(new Error("unexpected crash")), {
        rootCommand: testRoot,
        args: [],
      }),
    ).toBe("flush-unchanged");
  });
});

describe("hasRootVersionFlag", () => {
  it.each([
    [["--version"], true],
    [["-v"], false],
    [["--version=true"], true],
    [["--version=false"], true],
    [["-v=1"], false],
    [["-hv"], false],
    [["-xv"], false],
    [["--version", "true"], true],
    [["--version", "foo"], true],
    [["-v", "1"], false],
    [["--debug", "-v"], false],
    [["--profile", "-v"], false],
    [["--profile=x", "-v"], false],
    [["-o", "-v"], false],
    // `--completions` consumes its shell value, so the root `--version` behind it still counts.
    [["--completions", "bash", "--version"], true],
    [["--completions", "--version"], false],
    [["db", "reset", "--version", "20240101000000"], false],
    [["migration", "squash", "--version", "x"], false],
    [["branches", "-v"], false],
    [["--", "--version"], false],
    [[], false],
  ])("%j -> %s", (args, expected) => {
    expect(hasRootVersionFlag(args as ReadonlyArray<string>)).toBe(expected);
  });

  it("hasRootHelpOrVersionFlag sees the root --version behind --completions and its value", () => {
    expect(hasRootHelpOrVersionFlag(["--completions", "bash", "--version"])).toBe(true);
  });
});
