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
 * the shipped binary stay separated, matching Go cobra's `SilenceUsage`
 * behavior (`apps/cli-go/cmd/root.go:97`) for the same failure.
 */
describe("legacy CLI required-flag/choice parse errors (CLI-1901)", () => {
  test("an unrecognized flag: stdout stays clean, stderr is a single Go-parity line (no help dump, no duplicate)", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["branches", "--this-flag-does-not-exist"],
      { entrypoint: "legacy" },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unrecognized flag: --this-flag-does-not-exist");
    // The library's own duplicate print plus the debug suggestion would be
    // 3+ lines; the fix leaves exactly the one error line and the
    // suggestion line.
    expect(stderr.trim().split("\n")).toHaveLength(2);
  });
});
