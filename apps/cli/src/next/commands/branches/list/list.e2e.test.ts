import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 10_000;

describe("supabase branches list", () => {
  test(
    "exits with an error and suggestion when the project is not linked",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(["branches", "list"], {
        env: { SUPABASE_ACCESS_TOKEN: "fake-token-for-testing" },
      });
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain("supabase link");
    },
  );

  test(
    "--help exits successfully and describes the command",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["branches", "list", "--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("List all remote branches");
    },
  );
});
