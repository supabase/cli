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
