import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

describe("supabase logout", () => {
  test("shows help text", () => {
    return runSupabase(["logout", "--help"]).then(({ stdout, exitCode }) => {
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Log out of Supabase");
    });
  });

  test("exits with error in non-interactive JSON mode without --yes", () => {
    return runSupabase(["logout", "--output-format", "json"]).then(
      ({ stdout, stderr, exitCode }) => {
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain("prompt for confirmation");
      },
    );
  });

  test("succeeds with --yes in JSON mode when not logged in", () => {
    return runSupabase(["logout", "--yes", "--output-format", "json"]).then(({ exitCode }) => {
      expect(exitCode).toBe(0);
    });
  });
});
