import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

describe("supabase logout", () => {
  test("shows help text", async () => {
    const { stdout, exitCode } = await runSupabase(["logout", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Log out of Supabase");
  });

  test("exits with error in non-interactive JSON mode without --yes", async () => {
    const { stdout, stderr, exitCode } = await runSupabase(["logout", "--output-format", "json"]);
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain("prompt for confirmation");
  });

  test("succeeds with --yes in JSON mode when not logged in", async () => {
    const { exitCode } = await runSupabase(["logout", "--yes", "--output-format", "json"]);
    expect(exitCode).toBe(0);
  });
});
