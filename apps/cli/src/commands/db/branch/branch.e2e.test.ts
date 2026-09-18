import { describe, expect, test } from "vitest";
import { makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase db branch (removed)", () => {
  test(
    "list exits 1 with the removal message and its replacement suggestion",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stderr } = await runSupabase(["db", "branch", "list"], {
        home: home.dir,
        env: { HOME: home.dir },
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("supabase db branch list was removed.");
      expect(stderr).toContain(
        "Local database branches are no longer supported. For hosted preview branches, see `supabase branches --help`.",
      );
    },
  );
});
