import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

/**
 * CLI-1906: the real bug here is the actual OS process exit code —
 * `ProcessControl.exit` calls real `process.exit(code)`, so only a genuine
 * subprocess run proves the shipped binary's exit code changed. Everything
 * else about this fix (`exitCodeForFailure`'s classification) is covered by
 * `run.unit.test.ts` and `run.integration.test.ts`; this is the one minimal
 * case that observes the real subprocess boundary.
 */
describe("legacy CLI process exit codes (CLI-1906)", () => {
  test("bare `branches` (no subcommand, no --help) exits 0", async () => {
    const { exitCode } = await runSupabase(["branches"], { entrypoint: "legacy" });
    expect(exitCode).toBe(0);
  });

  test("a genuine parse error still exits 1", async () => {
    const { exitCode } = await runSupabase(["branches", "--this-flag-does-not-exist"], {
      entrypoint: "legacy",
    });
    expect(exitCode).toBe(1);
  });
});

/**
 * CLI-1901: a required-flag/choice parse failure used to dump the full help
 * doc to **stdout** and print the error **twice** on stderr. The buffering
 * mechanism that fixes this (`withoutParseErrorHelpDump` in `run.ts`) is
 * already covered against a real command definition, in-process, by
 * `run.integration.test.ts` — this is the one minimal case that observes the
 * real subprocess boundary: whether the actual `stdout`/`stderr` streams of
 * the shipped binary stay separated, and whether the error text is
 * de-duplicated, matching the real `apps/cli-go/supabase-go` binary (Go
 * still shows a usage block for an unrecognized flag — raised during
 * `ParseFlags`, before `PersistentPreRunE` sets `SilenceUsage`
 * (`apps/cli-go/cmd/root.go:97`) — always on stderr, never stdout;
 * verified directly against the built Go binary).
 */
describe("legacy CLI required-flag/choice parse errors (CLI-1901)", () => {
  test("an unrecognized flag: stdout stays clean, the help/usage content and the single error line land on stderr with no duplicate", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["branches", "--this-flag-does-not-exist"],
      { entrypoint: "legacy" },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    // Matches Go's still-shown usage block for this error class (see the
    // describe-level comment) — this library's help doc isn't byte-identical
    // to cobra's shorter usage template, but it's on the right stream now.
    expect(stderr).toContain("USAGE");
    // The error text appears exactly once — before the fix, the library's own
    // duplicate render put it on stderr a second time (on top of the stdout
    // help dump this test doesn't even need to check for, since stdout is
    // asserted empty above).
    const occurrences = stderr.split("Unrecognized flag: --this-flag-does-not-exist").length - 1;
    expect(occurrences).toBe(1);
    expect(
      stderr.trim().endsWith("Try rerunning the command with --debug to troubleshoot the error."),
    ).toBe(true);
  });
});
