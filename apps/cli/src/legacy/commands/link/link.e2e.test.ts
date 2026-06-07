import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase link (legacy)", () => {
  // Golden-path surface test: in a real subprocess with no TTY, no --project-ref
  // and no SUPABASE_PROJECT_ID, ref resolution fails before any API call with the
  // cobra-style required-flag error. Validates dispatch + ref-resolution wiring
  // without needing a network fixture.
  test(
    "without a resolvable project ref exits 1 with the required-flag error",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(["link"], {
        entrypoint: "legacy",
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain(`required flag(s) "project-ref" not set`);
    },
  );
});
