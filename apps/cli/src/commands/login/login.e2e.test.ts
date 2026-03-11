import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

describe("supabase login", () => {
  test("succeeds with a valid token", async () => {
    const token = "sbp_" + "a".repeat(40);
    const { stdout, exitCode } = await runSupabase(["login", "--token", token]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Logged in successfully");
  });

  test("fails with an invalid token", async () => {
    const { stdout, stderr, exitCode } = await runSupabase(["login", "--token", "bad-token"]);
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain("Invalid access token format");
  });

  test("fails without token in non-TTY mode", async () => {
    const { stdout, stderr, exitCode } = await runSupabase(["login"]);
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain("Cannot prompt for token in non-interactive mode");
  });

  test("succeeds with SUPABASE_ACCESS_TOKEN env var", async () => {
    const token = "sbp_" + "a".repeat(40);
    const { stdout, exitCode } = await runSupabase(["login"], {
      env: { SUPABASE_ACCESS_TOKEN: token },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Logged in successfully");
  });

  test("shows help text with new flags", async () => {
    const { stdout, exitCode } = await runSupabase(["login", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Log in to Supabase");
    expect(stdout).toContain("--token");
    expect(stdout).toContain("--name");
    expect(stdout).toContain("--no-browser");
  });
});
