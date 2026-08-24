import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const LOGIN_TIMEOUT_MS = 5_000;

describe("supabase login", () => {
  test("succeeds with a valid token", { timeout: LOGIN_TIMEOUT_MS }, () => {
    const token = "sbp_" + "a".repeat(40);
    return runSupabase(["login", "--token", token]).then(({ stdout, exitCode }) => {
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Logged in successfully");
    });
  });

  test("fails with an invalid token", { timeout: LOGIN_TIMEOUT_MS }, () => {
    return runSupabase(["login", "--token", "bad-token"]).then(({ stdout, stderr, exitCode }) => {
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain("Invalid access token format");
    });
  });
});
