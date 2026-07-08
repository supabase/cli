import { Cause } from "effect";
import { CliError } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";

import { exitCodeForFailure, extractCommandPath, shouldUseGlobalSignalInterrupt } from "./run.ts";

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
});
