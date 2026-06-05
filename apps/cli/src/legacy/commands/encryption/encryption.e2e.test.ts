import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase encryption (legacy)", () => {
  // Golden-path e2e: validates real subprocess dispatch + ref-resolution error
  // wiring for the get path. With an isolated HOME and no --project-ref /
  // SUPABASE_PROJECT_ID, the resolver fails before any API call.
  test(
    "get-root-key without a resolvable project ref exits non-zero with the not-linked message",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(["encryption", "get-root-key"], {
        entrypoint: "legacy",
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain("Cannot find project ref");
    },
  );

  // Validates the piped-stdin read path reaches the resolver in a real
  // subprocess — the key is consumed from stdin, then ref resolution fails.
  test(
    "update-root-key with piped key but no resolvable ref exits non-zero",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(["encryption", "update-root-key"], {
        entrypoint: "legacy",
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
        stdin: "newkey\n",
      });
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain("Cannot find project ref");
    },
  );
});
