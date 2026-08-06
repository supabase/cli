import { Cause } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";

import { legacyBranchesCommand } from "../../legacy/commands/branches/branches.command.ts";
import { legacyMigrationCommand } from "../../legacy/commands/migration/migration.command.ts";
import { legacySsoCommand } from "../../legacy/commands/sso/sso.command.ts";
import { LegacyGoChildExitError } from "../legacy/legacy-go-child-exit.error.ts";
import {
  classifyParseErrorConsoleOutput,
  exitCodeForFailure,
  extractCommandPath,
  shouldReportFailure,
  shouldUseGlobalSignalInterrupt,
} from "./run.ts";

// Real command tree (not a hand-rolled stand-in) so `classifyParseErrorConsoleOutput`'s
// alias resolution (`flagAliasesFor`, via `context.rootCommand`) has real `Flag.withAlias`
// declarations to walk — e.g. `sso add`'s `type` flag aliases to `-t` (`add.command.ts`).
const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyBranchesCommand, legacyMigrationCommand, legacySsoCommand]),
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

  it("treats --flag=value as a single token", () => {
    expect(extractCommandPath(["--output-format=json", "functions", "serve"])).toEqual([
      "functions",
      "serve",
    ]);
  });
});

describe("shouldUseGlobalSignalInterrupt", () => {
  it("opts out for self-managed signal commands, even behind global flags", () => {
    expect(shouldUseGlobalSignalInterrupt(["functions", "serve"])).toBe(false);
    // `db reset` drives the bootstrap seam (holds signals for the Go child), so it must not
    // be wrapped in the global handler either.
    expect(shouldUseGlobalSignalInterrupt(["db", "reset"])).toBe(false);
    expect(
      shouldUseGlobalSignalInterrupt(["--workdir", "/tmp/app", "functions", "serve", "--debug"]),
    ).toBe(false);
  });

  it("opts in for ordinary commands, including native start/db start (each installs no signal handling of its own, so the global wrapper's rollback-on-interrupt is the only thing that runs legacyRollbackStart on Ctrl-C)", () => {
    expect(shouldUseGlobalSignalInterrupt(["functions", "list"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["db", "push"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["projects", "list"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["start"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["db", "start"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt([])).toBe(true);
  });

  it("opts out for a shell's own additional self-managed commands, without affecting other shells sharing the same argv path", () => {
    // `next start` already races its own flows against `interruptOnSignal` (see
    // `next/cli/main.ts`'s call site) — matched purely against argv, `run.ts` itself can't tell
    // this apart from legacy's native `start`, so the exemption is additive per shell instead of
    // baked into the shared `selfManagedSignalCommands` list.
    expect(shouldUseGlobalSignalInterrupt(["start"], [["start"]])).toBe(false);
    // Without the override, the same argv still opts in (this is what legacy's own call site
    // relies on for native start's rollback-on-interrupt).
    expect(shouldUseGlobalSignalInterrupt(["start"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["start"], [])).toBe(true);
  });
});

describe("exitCodeForFailure", () => {
  // CLI-1906: a group command's default handler (e.g. bare `supabase branches`, which
  // has subcommands but no runnable handler of its own) fails with exactly this shape:
  // ShowHelp with an empty `errors` array. `CliError.ShowHelp` declares
  // `[Runtime.errorExitCode] = this.errors.length ? 1 : 0`, so this reads as exit 0 —
  // matching Go cobra's `flag.ErrHelp` handling for non-Runnable commands. Before
  // CLI-1906, this case always returned 1.
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

  // `Cause.squash` on a `Die` cause returns the raw defect (a plain `Error`, with no
  // `Runtime.errorExitCode` marker at all). This must still fall back to the default
  // failure exit code (1), not silently pass through as a "clean" exit — this is the real
  // unexpected-crash path through `runCli` that must keep exiting 1.
  it("exits 1 for a defect with no typed failure", () => {
    const cause = Cause.die(new Error("unexpected crash"));
    expect(exitCodeForFailure(cause)).toBe(1);
  });

  it("exits 130 when interrupted, regardless of any other failure reason", () => {
    expect(exitCodeForFailure(Cause.interrupt())).toBe(130);
  });

  // CLI-1879: a delegated Go child's exact exit code (not just a generic 1)
  // must reach the user, via the `LegacyGoChildExitError`'s
  // `[Runtime.errorExitCode]` marker.
  it("exits with a LegacyGoChildExitError's exact exit code", () => {
    const cause = Cause.fail(
      new LegacyGoChildExitError({ exitCode: 130, message: "supabase-go exited with code 130" }),
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

  // CLI-1879: the child already wrote its own detailed failure to the
  // inherited stderr, so `runCli`'s generic line would be a duplicate Go
  // itself never prints.
  it("does not report a LegacyGoChildExitError", () => {
    const cause = Cause.fail(
      new LegacyGoChildExitError({ exitCode: 1, message: "supabase-go exited with code 1" }),
    );
    expect(shouldReportFailure(cause, 1)).toBe(false);
  });

  it("reports a non-ShowHelp failure", () => {
    expect(shouldReportFailure(Cause.fail(new Error("boom")), 1)).toBe(true);
  });

  // Regression guard: `CliError.ShowHelp` ALSO sets Effect's shared
  // `[Runtime.errorReported]` marker to `false` (for an unrelated reason — the
  // CLI framework already rendered help/usage text). `shouldReportFailure`
  // must NOT key on that shared marker, or it would also suppress
  // `normalizeCause`'s Go-parity rendering for a `MissingOption` wrapped in
  // `ShowHelp` (e.g. `Error: required flag(s) "type" not set`) — silently
  // dropping that message for every command with a required flag.
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

// CLI-1901: a required-flag/choice parse failure used to dump the full help
// doc to stdout AND print the error twice (once from the vendored `effect`
// CLI library's own `showHelp()`, once from this repo's own Go-parity
// renderer). `withoutParseErrorHelpDump` fixes this by buffering the
// library's own `Console.log`/`Console.error` writes and disposing of them
// per this classifier's verdict — this suite covers the classifier;
// `run.integration.test.ts` covers the end-to-end buffering/flush behavior
// against real command definitions, and `run.e2e.test.ts` /
// `sso.e2e.test.ts` cover the real subprocess stdout/stderr streams.
describe("classifyParseErrorConsoleOutput", () => {
  // Go cobra's `PersistentPreRunE` sets `SilenceUsage = true`
  // (`apps/cli-go/cmd/root.go:97`) BEFORE `ValidateRequiredFlags`
  // (`command.go:1007`) runs — verified against the real `supabase-go`
  // binary (`sso add` without `--type`): a single clean stderr line, no
  // usage block. `MissingOption` is the one tag that maps to that stage.
  it("drops the help dump for a missing required flag", () => {
    const cause = Cause.fail(
      new CliError.ShowHelp({
        commandPath: ["supabase", "sso", "add"],
        errors: [new CliError.MissingOption({ option: "type" })],
      }),
    );
    // `--type` (nor its `-t` alias) never appears on argv at all — genuinely absent.
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["sso", "add", "--project-ref", "x"],
      }),
    ).toBe("drop");
  });

  // Multiple simultaneously-missing required flags: still `ValidateRequiredFlags`,
  // still post-`PersistentPreRunE` in Go — must still drop, not just for a lone error.
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

  // CLI-1901 (Codex review finding): the vendored library raises the SAME
  // `MissingOption` tag whether a required flag was never given at all, or
  // given with no value following it (e.g. `sso add --type` as the last
  // token) — it has no distinct "value required" error. Go's own pflag does
  // distinguish these: a present-but-valueless flag is a `ParseFlags`-time
  // error (`flag needs an argument: --type`), raised BEFORE
  // `PersistentPreRunE` sets `SilenceUsage` — verified against the real
  // `apps/cli-go/supabase-go` binary, which still prints its full usage block
  // to stderr for this input. `isMissingFlagTokenPresent` recovers this
  // distinction from raw argv so this case flushes the help doc instead of
  // silently dropping it like a genuinely-absent flag.
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

  // Codex review finding (CLI-1901 follow-up): `--` is the standard operand
  // terminator — everything after it is positional, never a flag occurrence,
  // for ANY option (mirrors the vendored `effect` lexer's own
  // `argv.indexOf("--")` cutoff, `internal/lexer.ts`). Verified against the
  // real `apps/cli-go/supabase-go` binary:
  // `migration repair --local -- 20230101000000 --status` prints a bare
  // `required flag(s) "status" not set`, no usage block — Go correctly parses
  // the literal `--status` string as a second positional `version`, leaving
  // the real `--status` flag genuinely unset. Without the `--` cutoff,
  // `isMissingFlagTokenPresent` would find that trailing `--status` string
  // anywhere in argv and wrongly conclude the flag was given but missing its
  // value.
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

  // Codex review finding (CLI-1901 follow-up): `sso add`'s `type` flag also has
  // a short alias, `-t` (`add.command.ts`). Go's pflag treats a present-but-
  // valueless SHORT flag exactly like the long form — `parseSingleShortArg`
  // raises the same `ValueRequiredError` as `parseLongArg`, same timing, same
  // "usage still shown" outcome — verified against the real
  // `apps/cli-go/supabase-go` binary (`sso add -t`: full usage block on
  // stderr, byte-parallel to `sso add --type`). `flagAliasesFor` resolves
  // `type`'s aliases from the real command tree (via `context.rootCommand`)
  // so `isMissingFlagTokenPresent` recognizes `-t` here too, instead of
  // misclassifying it as a genuinely-absent flag.
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

  // Codex review finding (CLI-1901 follow-up): `sso add --project-ref --type`
  // omits `--type`'s value, but `--type` immediately follows `--project-ref`
  // (a value-taking `Flag.string`, `add.command.ts`). Verified against the
  // real `apps/cli-go/supabase-go` binary: pflag's `parseLongArg`
  // (`flag.go`) unconditionally consumes the very next argv entry as
  // `--project-ref`'s value, even though it looks like another flag — so
  // `--type` is never seen as its own occurrence, and Go shows no usage at
  // all (only its own "type" required-flag error, `SilenceUsage`-suppressed).
  // The vendored `effect` parser does NOT eagerly consume a flag-shaped
  // token as a value (`internal/parser.ts`'s `consumeFlagValueWithTokens`
  // only consumes a following `Value`-tagged token), so `--type` remains its
  // own token and raises its own `MissingOption` here too — but the raw scan
  // must still recognize that `--type` was effectively consumed as
  // `--project-ref`'s value, matching Go, instead of concluding `--type` is
  // present but missing its value (which would wrongly flush the help doc).
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

  // Codex review finding (CLI-1901 follow-up): `isValueTakingFlagTokenFor`
  // only inspects the resolved LEAF command's own flags, so it doesn't know
  // `--network-id` (a value-taking GLOBAL flag, `globalFlagsWithValues` in
  // `run.ts`) consumes the very next argv entry. Verified against pflag's
  // `parseLongArg` (`flag.go`): `--network-id --status` hands the literal
  // string `--status` to `--network-id` as its value, so the required
  // `status` flag (`migration repair`, `Flag.choice`) is never seen as its
  // own occurrence and keeps Go's `SilenceUsage` treatment (no usage shown).
  // Without OR-ing `globalFlagsWithValues` into the scan's value-taking
  // predicate, the raw `--status` token would be found anyway and wrongly
  // flush the help doc.
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

  // Codex review finding (CLI-1901 follow-up): a literal `--` immediately
  // after a value-taking flag is NOT a genuine operand terminator in Go —
  // pflag's `parseLongArg` (`flag.go`) pops the very next raw token as the
  // flag's value with no shape check at all, so `--project-ref --` hands the
  // literal string `--` to `--project-ref`. Parsing then resumes normally on
  // `--type`, which (nothing follows it) raises pflag's own
  // `ValueRequiredError` — a `ParseFlags`-time error, usage still shown, NOT
  // `SilenceUsage`-suppressed. Precomputing `args.indexOf("--")` before the
  // value-consumption scan would wrongly treat that consumed `--` as the
  // terminator and drop `--type` from the scan entirely, misclassifying
  // `type` as genuinely absent.
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
    // `--type-hint` is a different flag token — must not false-positive-match `--type`.
    expect(
      classifyParseErrorConsoleOutput(cause, {
        rootCommand: testRoot,
        args: ["sso", "add", "--type-hint", "x"],
      }),
    ).toBe("drop");
  });

  // Go's `ParseFlags` (`command.go:919`) validates `Flag.choice` values BEFORE
  // `PersistentPreRunE` runs — verified against the real binary (`sso add --type
  // bogus`): Go still shows its usage block, on stderr. Same for an unrecognized
  // flag and a missing positional argument (both also pre-`PersistentPreRunE`).
  it("flushes the help dump to stderr for an invalid Flag.choice value", () => {
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

  // A mix (e.g. a missing required flag alongside an unrecognized flag) can't
  // actually occur in practice — the library fails fast on the earlier
  // `ParseFlags`-class error before `MissingOption` is ever checked — but the
  // classifier must still not mistake a mix for the all-`MissingOption` case.
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
