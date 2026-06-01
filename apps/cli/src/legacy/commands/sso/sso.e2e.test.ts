import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase sso (legacy)", () => {
  test(
    "info --output-format=json emits derived URLs (no auth needed)",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(
        ["sso", "info", "--project-ref", TEST_PROJECT_REF, "--output-format", "json"],
        { entrypoint: "legacy", env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`https://${TEST_PROJECT_REF}.supabase.co/auth/v1/sso/saml/acs`);
      expect(stdout).toContain(`https://${TEST_PROJECT_REF}.supabase.co/auth/v1/sso/saml/metadata`);
      expect(stdout).toContain(`https://${TEST_PROJECT_REF}.supabase.co`);
    },
  );

  test("info text mode prints all three URLs", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stdout } = await runSupabase(
      ["sso", "info", "--project-ref", TEST_PROJECT_REF],
      { entrypoint: "legacy", env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`https://${TEST_PROJECT_REF}.supabase.co/auth/v1/sso/saml/acs`);
    expect(stdout).toContain(`https://${TEST_PROJECT_REF}.supabase.co/auth/v1/sso/saml/metadata`);
  });

  test(
    "show with invalid UUID exits 1 with Go-format message",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(
        ["sso", "show", "not-a-uuid", "--project-ref", TEST_PROJECT_REF],
        { entrypoint: "legacy", env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
      );
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain(`identity provider ID "not-a-uuid" is not a UUID`);
    },
  );

  test(
    "remove with invalid UUID exits 1 with Go-format message",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(
        ["sso", "remove", "not-a-uuid", "--project-ref", TEST_PROJECT_REF],
        { entrypoint: "legacy", env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
      );
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain(`identity provider ID "not-a-uuid" is not a UUID`);
    },
  );

  test(
    "update with invalid UUID exits 1 with Go-format message",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(
        ["sso", "update", "not-a-uuid", "--project-ref", TEST_PROJECT_REF],
        { entrypoint: "legacy", env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
      );
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain(`identity provider ID "not-a-uuid" is not a UUID`);
    },
  );
});
