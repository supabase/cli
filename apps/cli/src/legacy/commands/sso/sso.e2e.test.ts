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

  // CLI-1901: `add`'s `--type` has no `Flag.optional` (see `add.command.ts`)
  // — Go marks it required via `MarkFlagRequired("type")` (`cmd/sso.go:65`)
  // — so a missing/invalid `--type` used to dump the full help doc to
  // stdout AND print the error twice on stderr. No auth/network call ever
  // happens for either case: flag parsing fails before the handler runs.
  //
  // A missing required flag and an invalid choice value get different
  // treatment, matching the real `apps/cli-go/supabase-go` binary (verified
  // directly against it): Go's `PersistentPreRunE` sets `SilenceUsage = true`
  // (`cmd/root.go:97`) BEFORE `ValidateRequiredFlags` runs, so a missing
  // `--type` is a single clean stderr line with no usage block — but
  // `Flag.choice` validation happens during `ParseFlags`, BEFORE that point,
  // so Go still shows a usage block for an invalid `--type` value, always on
  // stderr, never stdout.
  test(
    "add without --type: stdout stays clean, stderr is a single Go-parity line (no usage block)",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(
        ["sso", "add", "--project-ref", TEST_PROJECT_REF],
        { entrypoint: "legacy" },
      );
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
      const { exitCode, stdout, stderr } = await runSupabase(
        ["sso", "add", "--type", "bogus", "--project-ref", TEST_PROJECT_REF],
        { entrypoint: "legacy" },
      );
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
