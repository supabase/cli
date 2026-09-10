import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase encryption", () => {
  test(
    "get-root-key without a resolvable project ref exits non-zero with the not-linked message",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(["encryption", "get-root-key"], {
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain("Cannot find project ref");
    },
  );

  test(
    "update-root-key with piped key but no resolvable ref exits non-zero",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(["encryption", "update-root-key"], {
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
        stdin: "newkey\n",
      });
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain("Cannot find project ref");
    },
  );
});
