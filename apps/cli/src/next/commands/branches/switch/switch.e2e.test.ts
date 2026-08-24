import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 10_000;

describe("supabase branches switch", () => {
  test("--help exits successfully and describes the command", { timeout: E2E_TIMEOUT_MS }, () =>
    runSupabase(["branches", "switch", "--help"]).then(({ exitCode, stdout }) => {
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Switch the active branch");
    }),
  );

  test(
    "exits with an error and suggestion when the project is not linked",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runSupabase(["branches", "switch", "main"], {
        env: { SUPABASE_ACCESS_TOKEN: "fake-token-for-testing" },
      }).then(({ exitCode, stdout, stderr }) => {
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain("supabase link");
      }),
  );
});
