import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

const LOGIN_TIMEOUT_MS = 5_000;

describe("supabase login", () => {
  test("succeeds with a valid token", { timeout: LOGIN_TIMEOUT_MS }, async () => {
    const token = "sbp_" + "a".repeat(40);
    const { stdout, exitCode } = await runSupabase(["login", "--token", token]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Logged in successfully");
  });

  test("fails with an invalid token", { timeout: LOGIN_TIMEOUT_MS }, async () => {
    const { stdout, stderr, exitCode } = await runSupabase(["login", "--token", "bad-token"]);
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain("Invalid access token format");
  });
});
