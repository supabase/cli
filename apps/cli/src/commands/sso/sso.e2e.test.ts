import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase sso", () => {
  test(
    "info --output-format=json emits derived URLs (no auth needed)",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(
        ["sso", "info", "--project-ref", TEST_PROJECT_REF, "--output-format", "json"],
        { env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
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
      { env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
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
        { env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
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
        { env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
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
        { env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
      );
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain(`identity provider ID "not-a-uuid" is not a UUID`);
    },
  );

  // Usage-silencing is set before required-flag validation, so a missing
  // `--type` prints a single clean stderr line with no usage block — but
  // `Flag.choice` validation runs during parsing, before that point, so an
  // invalid `--type` value still shows a usage block.
  test(
    "add without --type: stdout stays clean, stderr is a single Go-parity line (no usage block)",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase([
        "sso",
        "add",
        "--project-ref",
        TEST_PROJECT_REF,
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(`required flag(s) "type" not set`);
      expect(stderr).not.toContain("USAGE");
      expect(stderr.trim().split("\n")).toHaveLength(2);
    },
  );

  test(
    "add with an invalid --type value: stdout stays clean, the usage content and the single error line land on stderr with no duplicate",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase([
        "sso",
        "add",
        "--type",
        "bogus",
        "--project-ref",
        TEST_PROJECT_REF,
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("USAGE");
      const occurrences = stderr.split(`Invalid value for flag --type: "bogus"`).length - 1;
      expect(occurrences).toBe(1);
      expect(
        stderr.trim().endsWith("Try rerunning the command with --debug to troubleshoot the error."),
      ).toBe(true);
    },
  );
});
