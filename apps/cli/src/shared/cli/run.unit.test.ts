import { Cause } from "effect";
import { CliError } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";

import { LegacyGoChildExitError } from "../legacy/legacy-go-child-exit.error.ts";
import {
  exitCodeForFailure,
  extractCommandPath,
  shouldReportFailure,
  shouldUseGlobalSignalInterrupt,
} from "./run.ts";

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
    expect(shouldUseGlobalSignalInterrupt(["start"])).toBe(false);
    expect(shouldUseGlobalSignalInterrupt(["db", "start"])).toBe(false);
    // `db reset` drives the bootstrap seam (holds signals for the Go child), so it must not
    // be wrapped in the global handler either.
    expect(shouldUseGlobalSignalInterrupt(["db", "reset"])).toBe(false);
    expect(
      shouldUseGlobalSignalInterrupt(["--workdir", "/tmp/app", "functions", "serve", "--debug"]),
    ).toBe(false);
  });

  it("opts in for ordinary commands", () => {
    expect(shouldUseGlobalSignalInterrupt(["functions", "list"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["db", "push"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt(["projects", "list"])).toBe(true);
    expect(shouldUseGlobalSignalInterrupt([])).toBe(true);
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
